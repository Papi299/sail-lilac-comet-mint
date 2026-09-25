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
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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
  HLS08_VARIANTS,
  HLS_FIXTURE_HOSTNAME,
  HLS_FIXTURE_LOOPBACK,
  HLS_FRAGMENT_FAMILIES,
  HLS_KEY_ROUTE,
  HLS_MASTER_ROUTE,
  HLS_MEDIA_ROUTE,
  HLS_PAGE_ROUTE,
  HLS_SYNTHETIC_PUBLIC_ADDRESS,
  classifyHlsFixturePath,
  createHlsPageUrlValidator,
  hlsFixtureOrigin,
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
  HLS08_ORCHESTRATOR,
  HLS08_OVERLAY_COPIED_PATHS,
  HLS_ACCEPTANCE_MODES,
  HLS_ACCEPTANCE_MODE_FLAG,
  assertNonDeployableTag,
  hlsAcceptanceRunArgs,
  hlsOverlayBuildArgs,
  hlsOverlayDockerfile,
  hlsOverlayImageTag,
  hlsRunPostureViolations,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-container.mjs";
import {
  HLS_MODE_EVIDENCE_SCHEMAS,
  acceptanceIdentityChecks,
  buildAcceptanceEvidence,
  imageRemovalFact,
  parseHlsAcceptanceArgv,
  renderAcceptanceEvidence,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-acceptance-mode.mjs";
import {
  HLS09_MANDATORY_CHECKS,
  HLS09_NON_CLAIMS,
  HLS09_RELEASE_EVIDENCE_SCHEMA,
  HLS09_RELEASE_IDENTITY_CHECKS,
  buildHlsReleaseEvidence,
  validateHlsReleaseChildRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-release-evidence.mjs";
import {
  candidateImageTag,
  releaseHlsAcceptanceRunArgs,
} from "../deploy/acceptance/ytdlp-generic/lib/release-container.mjs";
import { OVERLAY_COPIED_PATHS } from "../deploy/acceptance/ytdlp-generic/lib/split-container.mjs";
import {
  OVERLAY_RUNTIME_COMPATIBILITY_FILES,
  ProvenanceError,
} from "../deploy/acceptance/ytdlp-generic/lib/split-provenance.mjs";
import {
  HLS08_EVIDENCE_SCHEMA,
  HLS08_FORBIDDEN_EVIDENCE_SUBSTRINGS,
  HLS08_MANDATORY_CHECKS,
  HLS08_OVERLAY_IDENTITY_CHECKS,
  HLS_BEHAVIORAL_MANDATORY_CHECKS,
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
  HLS08_ADMISSION_FINDING,
  HLS08_HOSTNAME_FINDING,
  HLS08_PRIVACY_NEEDLES,
  describePrivacyFindings,
  inputOperand,
  scanRawPrivacyNeedles,
  validateDurablePrivacy,
  validateStructuredPrivacy,
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

// ── privacy placement ──────────────────────────────────────────────────────

describe("hls privacy placement", () => {
  const PORT = 40123;
  const H = HLS_FIXTURE_HOSTNAME;
  const page = hlsPageUrl(PORT);
  const origin = hlsFixtureOrigin(PORT);
  const mediaUrl = `${origin}/hls08/${mediaPlaylistUri("execution")}`;
  const fragmentUrl = `${origin}/hls08/${HLS_FRAGMENT_FAMILIES.positive}1.ts`;
  const opts = { needles: HLS08_PRIVACY_NEEDLES, hostname: H };
  const publicAdmitted = { webpageUrl: page, source: H };
  const JOB_IDS = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];

  /** A browser-safe analysis shaped like the Product's for the fixture. */
  const publicMeta = () => ({
    title: "HLS-08 deterministic fixture",
    thumbnail: null,
    duration: 6.0,
    source: H,
    extractor: "yt-dlp",
    webpageUrl: page,
    formats: [],
    presets: [
      { id: "preset:best", formatId: "preset:best", label: "Best", container: "mp4", hasVideo: true, hasAudio: true, fileSize: null },
      { id: "preset:360", formatId: "preset:360", label: "360p", container: "mp4", hasVideo: true, hasAudio: true, fileSize: null },
    ],
    capabilities: { mp3: false, merge: false },
    sourceQuality: { observedMaxHeight: 360, deliverableMaxHeight: 360, withheld: [] },
  });
  const publicFindings = (meta) => validateStructuredPrivacy("public", meta, { ...opts, admitted: publicAdmitted });
  const labels = (findings) => findings.map((f) => `${f.field}:${f.finding}`).sort();

  /** A durable row shaped like `worker_jobs` for one job, after analysis. */
  const jobRow = (jobId, over = {}) => ({
    job_id: jobId, url: page, format_id: "preset:best", principal_id: "private-access-user", status: "ready",
    progress: 100, stage_label: null, downloaded_bytes: null, total_bytes: null, speed: null, eta: null,
    error_code: null, safe_error_message: null, filename: "HLS-08 deterministic fixture.mp4", file_size: 600157,
    mime: "video/mp4", quality: "360p", container: "mp4", title: "HLS-08 deterministic fixture", thumbnail: null,
    source: H, extractor: "yt-dlp", created_at_ms: 1, updated_at_ms: 2, expires_at_ms: 3,
    object_key: `jobs/private-access-user/${jobId}/x.mp4`, started_at_ms: 1, finished_at_ms: 2, ...over,
  });
  const jobView = (jobId, over = {}) => ({
    jobId, status: "ready", filename: "HLS-08 deterministic fixture.mp4", title: "HLS-08 deterministic fixture",
    thumbnail: null, source: H, extractor: "yt-dlp", objectKey: `jobs/private-access-user/${jobId}/x.mp4`, ...over,
  });
  const durableInput = ({ rows, views, extraTables = {} } = {}) => ({
    tables: {
      split06_status_audit: [{ seq: 1, job_id: JOB_IDS[0], from_status: null, to_status: "queued", at_ms: 1 }],
      worker_jobs: rows ?? JOB_IDS.map((id) => jobRow(id)),
      ...extraTables,
    },
    views: views ?? JOB_IDS.map((id) => jobView(id)),
    expectedJobIds: JOB_IDS,
    pageUrl: page,
    hostname: H,
    needles: HLS08_PRIVACY_NEEDLES,
  });

  it("admits exactly webpageUrl = the page URL and source = the hostname on the public analysis", () => {
    assert.deepEqual(publicFindings(publicMeta()), []);
  });

  it("refuses every false admission of the -01 scanner in source and webpageUrl", () => {
    const badSources = [`${H}.evil`, `${H}X`, `${H}?x=1`, `${H}.`, H.toUpperCase(), `x${H}`];
    for (const source of badSources) {
      assert.deepEqual(
        labels(publicFindings({ ...publicMeta(), source })),
        [`source:${HLS08_ADMISSION_FINDING}`, `source:${HLS08_HOSTNAME_FINDING}`],
        source,
      );
    }
    const badPages = [
      `${page}?x=1`, `${page}#fragment`, `${page}/extra`, `${page}.evil`,
      hlsPageUrl(PORT + 1), `${origin}/hls08/other.html`, `https://${H}:${PORT}${HLS_PAGE_ROUTE}`,
    ];
    for (const webpageUrl of badPages) {
      assert.deepEqual(
        labels(publicFindings({ ...publicMeta(), webpageUrl })),
        [`webpageUrl:${HLS08_ADMISSION_FINDING}`, `webpageUrl:${HLS08_HOSTNAME_FINDING}`],
        webpageUrl,
      );
    }
    // The HLS acquisition URLs fail as an echo AND carry provenance needles.
    const media = labels(publicFindings({ ...publicMeta(), webpageUrl: mediaUrl }));
    for (const want of ["admitted-field-not-the-exact-echo", "fixture-hostname-outside-an-admitted-field",
      "media-playlist-route", "playlist-extension", "signature-parameter", "execution-marker", "private-marker-prefix"]) {
      assert.ok(media.includes(`webpageUrl:${want}`), want);
    }
    const fragment = labels(publicFindings({ ...publicMeta(), webpageUrl: fragmentUrl }));
    assert.ok(fragment.includes(`webpageUrl:${HLS08_ADMISSION_FINDING}`));
    assert.ok(fragment.includes("webpageUrl:fragment-name"));
  });

  it("refuses the exact hostname, or the exact page URL, in any unrelated field or key", () => {
    const cases = [
      [(m) => ({ ...m, title: H }), "title"],
      [(m) => ({ ...m, title: page }), "title"],
      [(m) => ({ ...m, title: `Watch on ${H}` }), "title"],
      [(m) => ({ ...m, thumbnail: page }), "thumbnail"],
      [(m) => ({ ...m, presets: [{ ...m.presets[0], label: H }, m.presets[1]] }), "presets[0].label"],
      [(m) => ({ ...m, sourceQuality: { ...m.sourceQuality, note: H } }), "sourceQuality.note"],
      [(m) => ({ ...m, formats: [{ url: page }] }), "formats[0].url"],
      [(m) => ({ ...m, capabilities: { ...m.capabilities, [H]: true } }), "capabilities.<key>"],
      // the -01 scanner admitted these as "bare" or "page-prefixed" anywhere
      [(m) => ({ ...m, title: `${H}.evil` }), "title"],
      [(m) => ({ ...m, title: `${H}X` }), "title"],
      [(m) => ({ ...m, title: `${H}?x=1` }), "title"],
      [(m) => ({ ...m, title: `${page}?x=1` }), "title"],
      [(m) => ({ ...m, title: `${page}#fragment` }), "title"],
      [(m) => ({ ...m, title: `${page}/extra` }), "title"],
      [(m) => ({ ...m, title: `${page}.evil` }), "title"],
      [(m) => ({ ...m, title: H.toUpperCase() }), "title"],
    ];
    for (const [mutate, field] of cases) {
      const findings = publicFindings(mutate(publicMeta()));
      assert.deepEqual(
        findings.filter((f) => f.finding === HLS08_HOSTNAME_FINDING).map((f) => f.field),
        [field],
        field,
      );
      assert.equal(findings.filter((f) => f.finding === HLS08_ADMISSION_FINDING).length, 0, field);
    }
  });

  it("requires each admitted echo to be present, a string, and exact", () => {
    const noPage = publicMeta();
    delete noPage.webpageUrl;
    assert.deepEqual(labels(publicFindings(noPage)), [`webpageUrl:${HLS08_ADMISSION_FINDING}`]);
    assert.deepEqual(labels(publicFindings({ ...publicMeta(), source: null })), [`source:${HLS08_ADMISSION_FINDING}`]);
    assert.deepEqual(labels(publicFindings({ ...publicMeta(), source: [H] })), [
      `source:${HLS08_ADMISSION_FINDING}`, `source[0]:${HLS08_HOSTNAME_FINDING}`,
    ]);
    // an admission names ONE path: the same field nested elsewhere is not admitted
    assert.deepEqual(
      labels(publicFindings({ ...publicMeta(), sourceQuality: { source: H } })),
      [`sourceQuality.source:${HLS08_HOSTNAME_FINDING}`],
    );
    assert.throws(() => validateStructuredPrivacy("x", {}, { ...opts, admitted: { source: "" } }), TypeError);
    assert.throws(() => validateStructuredPrivacy("x", {}, { needles: HLS08_PRIVACY_NEEDLES, hostname: "" }), TypeError);
  });

  it("refuses every HLS acquisition needle in any value or key, admitted fields included", () => {
    const provenance = [
      HLS08_RAW_FORMAT_ID, mediaUrl, fragmentUrl, `fail-seg-2.ts`, "playlistUrl", "hlsSelections", "clear-hls-remux",
      `${HLS_MASTER_ROUTE}`, `${origin}${HLS_KEY_ROUTE}`, ...HLS08_VARIANTS.map((v) => mediaPlaylistUri(v)),
      ...Object.values(HLS08_PRIVATE_MARKERS),
    ];
    for (const value of provenance) {
      assert.notEqual(validateStructuredPrivacy("s", { title: value }, opts).length, 0, value);
      assert.notEqual(validateStructuredPrivacy("s", { [value]: 1 }, opts).length, 0, value);
      assert.notEqual(scanRawPrivacyNeedles("raw", `\u0000${value}\u0000`, opts).length, 0, value);
    }
    for (const [label, needle] of Object.entries(HLS08_PRIVACY_NEEDLES)) {
      const found = validateStructuredPrivacy("s", { title: `a${needle}b` }, opts).map((f) => f.finding);
      assert.ok(found.includes(label), label);
    }
    // an exact echo exempts a field from the hostname rule only, never from needles
    assert.ok(
      validateStructuredPrivacy("s", { webpageUrl: `${page}` }, { ...opts, needles: { "page-route": HLS_PAGE_ROUTE }, admitted: { webpageUrl: page } })
        .some((f) => f.finding === "page-route"),
    );
    // and none of the needles matches the legitimate echoes themselves
    assert.deepEqual(scanRawPrivacyNeedles("raw", `${page}\u0000${H}`, opts), []);
  });

  it("reports surface, sanitized field path and label — never a scanned value", () => {
    const findings = validateStructuredPrivacy(
      "public",
      { ...publicMeta(), [HLS08_PRIVATE_MARKERS.execution]: { [H]: mediaUrl }, hlsSelections: { x: 1 } },
      { ...opts, admitted: publicAdmitted },
    );
    assert.ok(findings.length > 0);
    assert.ok(findings.every((f) => f.surface === "public"));
    const serialized = JSON.stringify(findings) + describePrivacyFindings(findings);
    for (const secret of [H, page, mediaUrl, HLS08_PRIVATE_MARKERS.execution, "://", "sig="]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.ok(findings.some((f) => f.field === "<key>.<key>" && f.finding === "media-playlist-route"));
    assert.ok(findings.some((f) => f.field === "<key>" && f.finding === "hlsSelections-field"));
  });

  it("refuses the hostname entirely on sourceQuality, upload and trace surfaces", () => {
    const quality = publicMeta().sourceQuality;
    assert.deepEqual(validateStructuredPrivacy("sourceQuality", quality, opts), []);
    assert.deepEqual(labels(validateStructuredPrivacy("sourceQuality", { ...quality, origin: H }, opts)), [`origin:${HLS08_HOSTNAME_FINDING}`]);
    const upload = {
      filename: "HLS-08 deterministic fixture.mp4", quality: "360p", mime: "video/mp4",
      objectKey: `jobs/private-access-user/${JOB_IDS[0]}/x.mp4`,
      contentDisposition: 'attachment; filename="HLS-08 deterministic fixture.mp4"', contentType: "video/mp4",
    };
    assert.deepEqual(validateStructuredPrivacy("upload", upload, opts), []);
    for (const field of Object.keys(upload)) {
      for (const leak of [H, page, `${H}.evil`]) {
        assert.deepEqual(
          labels(validateStructuredPrivacy("upload", { ...upload, [field]: `${upload[field]} ${leak}` }, opts)),
          [`${field}:${HLS08_HOSTNAME_FINDING}`],
          `${field} ${leak}`,
        );
      }
    }
    const trace = [{ event: "job-created", status: "queued" }];
    assert.deepEqual(validateStructuredPrivacy("acceptance trace", trace, opts), []);
    assert.deepEqual(
      labels(validateStructuredPrivacy("acceptance trace", [...trace, { event: H, status: null }], opts)),
      [`[1].event:${HLS08_HOSTNAME_FINDING}`],
    );
  });

  it("admits exactly durable url/source per expected job and view source, and nothing else", () => {
    const clean = validateDurablePrivacy(durableInput());
    assert.deepEqual(clean, { jobRowsAreTheExpectedJobs: true, viewsAreTheExpectedJobs: true, echo: [], rows: [], views: [] });

    const withRow = (i, over) => durableInput({ rows: JOB_IDS.map((id, j) => jobRow(id, j === i ? over : {})) });
    for (const url of [`${page}?x=1`, `${page}#fragment`, `${page}/extra`, `${page}.evil`, hlsPageUrl(PORT + 1), mediaUrl]) {
      const r = validateDurablePrivacy(withRow(1, { url }));
      assert.deepEqual(r.echo.map((f) => `${f.surface}:${f.field}`), ["worker_jobs[1]:url"], url);
      assert.ok(r.rows.some((f) => f.field === "url" && f.finding === HLS08_HOSTNAME_FINDING), url);
    }
    for (const source of [`${H}.evil`, `${H}X`, `${H}?x=1`, null]) {
      const r = validateDurablePrivacy(withRow(2, { source }));
      assert.deepEqual(r.echo.map((f) => `${f.surface}:${f.field}`), ["worker_jobs[2]:source"], String(source));
    }
    for (const field of ["title", "filename", "stage_label", "safe_error_message", "quality", "thumbnail"]) {
      for (const leak of [H, page]) {
        const r = validateDurablePrivacy(withRow(0, { [field]: leak }));
        assert.deepEqual(r.echo, [], field);
        assert.deepEqual(r.rows.map((f) => `${f.surface}:${f.field}:${f.finding}`), [`worker_jobs[0]:${field}:${HLS08_HOSTNAME_FINDING}`], field);
      }
    }
    // job views admit `source` only — the view has no url field
    const views = JOB_IDS.map((id) => jobView(id));
    views[1] = { ...views[1], title: H };
    views[2] = { ...views[2], url: page };
    const v = validateDurablePrivacy(durableInput({ views }));
    assert.deepEqual(v.views.map((f) => `${f.surface}:${f.field}`), ["job view 1:title", "job view 2:url"]);
    const badViewSource = JOB_IDS.map((id, i) => jobView(id, i === 0 ? { source: `${H}.evil` } : {}));
    assert.deepEqual(validateDurablePrivacy(durableInput({ views: badViewSource })).echo.map((f) => `${f.surface}:${f.field}`), ["job view 0:source"]);
    // every other table admits nothing
    const audit = validateDurablePrivacy(durableInput({ extraTables: { worker_idempotency_records: [{ idempotency_key: H }] } }));
    assert.deepEqual(audit.rows.map((f) => `${f.surface}:${f.field}`), ["worker_idempotency_records[0]:idempotency_key"]);
    // the rows must be exactly the expected jobs
    assert.equal(validateDurablePrivacy(durableInput({ rows: JOB_IDS.slice(0, 2).map((id) => jobRow(id)) })).jobRowsAreTheExpectedJobs, false);
    assert.equal(validateDurablePrivacy(durableInput({ rows: [...JOB_IDS, "d".repeat(32)].map((id) => jobRow(id)) })).jobRowsAreTheExpectedJobs, false);
    assert.equal(validateDurablePrivacy(durableInput({ views: [...views.slice(0, 2), null] })).viewsAreTheExpectedJobs, false);
  });

  describe("against a real Product SQLite database", () => {
    let dir;
    let productDb;
    before(async () => {
      await import("./register-ts-aliases.mjs");
      const [database, migrations, jobStore] = await Promise.all([
        import("../src/worker/state/database.server.ts"),
        import("../src/worker/state/migrations.server.ts"),
        import("../src/worker/state/sqlite-job-store.server.ts"),
      ]);
      productDb = { ...database, ...migrations, ...jobStore };
      dir = await mkdtemp(join(tmpdir(), "hls08-privacy-db-"));
    });
    after(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    const rawBytes = async (path) => {
      const parts = [];
      for (const name of (await readdir(dirname(path))).sort()) {
        if (name.startsWith(basename(path))) parts.push((await readFile(join(dirname(path), name))).toString("latin1"));
      }
      return parts.join("\n");
    };
    const tablesOf = (db) => {
      const out = {};
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
        out[name] = db.prepare(`SELECT * FROM "${name}"`).all();
      }
      return out;
    };

    it("admits the stored page/source echo in raw bytes, and refuses HLS provenance there", async () => {
      const path = join(dir, "worker.sqlite");
      const db = productDb.openWorkerDatabase({ path });
      try {
        productDb.applyMigrations(db);
        const store = new productDb.SQLiteJobStore({ db });
        const created = store.createJob({ url: page, formatId: "preset:best", principalId: "private-access-user" }, randomUUID());
        assert.equal(created.type, "created");
        const jobId = created.job.jobId;
        assert.equal(store.claimNextQueuedJob()?.jobId, jobId);
        assert.equal(
          store.completeAnalysis(jobId, { title: "HLS-08 deterministic fixture", thumbnail: null, source: H, extractor: "yt-dlp" }).type,
          "updated",
        );

        // The legitimate echoes really are in the raw bytes...
        const clean = await rawBytes(path);
        assert.ok(clean.includes(page) && clean.includes(H));
        // ...and the needle scan does not mistake them for provenance.
        assert.deepEqual(scanRawPrivacyNeedles("raw sqlite bytes", clean, opts), []);
        // The structured rows prove WHERE the hostname is stored.
        const view = store.getJob(jobId);
        assert.equal(view.source, H);
        const durable = validateDurablePrivacy({
          tables: tablesOf(db), views: [view], expectedJobIds: [jobId], pageUrl: page, hostname: H, needles: HLS08_PRIVACY_NEEDLES,
        });
        assert.deepEqual(durable, { jobRowsAreTheExpectedJobs: true, viewsAreTheExpectedJobs: true, echo: [], rows: [], views: [] });

        // A media-playlist signature stored anywhere is caught in the raw bytes.
        db.prepare("UPDATE worker_jobs SET stage_label = ? WHERE job_id = ?").run(`fetching ${mediaUrl}`, jobId);
        const leaked = scanRawPrivacyNeedles("raw sqlite bytes", await rawBytes(path), opts).map((f) => f.finding);
        for (const want of ["private-marker-prefix", "execution-marker", "playlist-extension", "signature-parameter", "media-playlist-route"]) {
          assert.ok(leaked.includes(want), want);
        }
        // and the structured row names the field.
        const rows = validateDurablePrivacy({
          tables: tablesOf(db), views: [view], expectedJobIds: [jobId], pageUrl: page, hostname: H, needles: HLS08_PRIVACY_NEEDLES,
        }).rows;
        assert.ok(rows.some((f) => f.surface === "worker_jobs[0]" && f.field === "stage_label" && f.finding === HLS08_HOSTNAME_FINDING));
      } finally {
        db.close();
      }
    });

    it("an HLS private marker alone, with no hostname, still fails the raw scan", async () => {
      const path = join(dir, "marker.sqlite");
      const db = productDb.openWorkerDatabase({ path });
      try {
        productDb.applyMigrations(db);
        const store = new productDb.SQLiteJobStore({ db });
        const created = store.createJob({ url: page, formatId: "preset:best", principalId: "private-access-user" }, randomUUID());
        store.claimNextQueuedJob();
        store.completeAnalysis(created.job.jobId, { title: HLS08_PRIVATE_MARKERS.browser, thumbnail: null, source: H, extractor: "yt-dlp" });
        const found = scanRawPrivacyNeedles("raw sqlite bytes", await rawBytes(path), opts).map((f) => f.finding);
        assert.deepEqual(found.sort(), ["browser-marker", "private-marker-prefix"]);
      } finally {
        db.close();
      }
    });
  });

  it("the admitted field names are the Product's own", async () => {
    await import("./register-ts-aliases.mjs");
    const contracts = await import("../src/shared/worker/contracts.ts");
    const shapeOf = (schema) => schema.shape ?? schema.innerType?.().shape ?? schema._def?.schema?.shape;
    const meta = shapeOf(contracts.VideoMetadataSchema);
    assert.ok(meta.webpageUrl && meta.source);
    const view = shapeOf(contracts.WorkerJobViewSchema);
    assert.ok(view.source);
    assert.equal(Object.hasOwn(view, "url"), false);
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
    assert.equal(record.schema, "hls08-deterministic-full-path-02");
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

// ── HLS-09: the explicit acceptance-mode boundary ──────────────────────────

const RELEASE_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const RELEASE_TAG = candidateImageTag(HEAD);
const RELEASE_HARNESS = "/var/tmp/hls09-harness/deploy/acceptance/ytdlp-generic";

/** The orchestrator's own argv: everything after `<image> --import … <orchestrator>`. */
function orchestratorArgv(dockerArgv, imageId) {
  const tail = dockerArgv.slice(dockerArgv.indexOf(imageId) + 1);
  assert.deepEqual(tail.slice(0, 4), ["--import", "./scripts/register-ts-aliases.mjs", "--experimental-strip-types", HLS08_ORCHESTRATOR]);
  return tail.slice(4);
}

function overlayDockerArgv() {
  return hlsAcceptanceRunArgs({
    imageId: OVERLAY_ID, image: hlsOverlayImageTag(HEAD), reportDir: REPORT, evidenceName: "hls08-x.json",
    provenance: {
      commit: HEAD, tree: TREE, acceptedBaseSourceCommit: BASE_SOURCE, contextClean: true,
      overlayRuntimeCompatibilityVerified: true, baseImage: BASE_IMAGE, baseDigest: BASE_DIGEST,
    },
  });
}

function releaseDockerArgv() {
  return releaseHlsAcceptanceRunArgs({
    imageId: RELEASE_IMAGE_ID, harnessDir: RELEASE_HARNESS, reportDir: "/var/tmp/hls09",
    mediaWorkspaceDir: "/var/tmp/hls09-media", evidenceName: "hls09-x.json",
    sourceCommit: HEAD, sourceTree: TREE, candidateTag: RELEASE_TAG,
  });
}

const OVERLAY_OPTS = Object.freeze({
  mode: "overlay", evidence: "/report/hls08-x.json", sourceCommit: HEAD, sourceTree: TREE, sourceContextClean: true,
  acceptedBaseSource: BASE_SOURCE, baseImage: BASE_IMAGE, baseDigest: BASE_DIGEST,
  overlayImage: hlsOverlayImageTag(HEAD), overlayImageId: OVERLAY_ID, overlayRuntimeCompatible: true,
});

const RELEASE_OPTS = Object.freeze({
  mode: "release-image", evidence: "/report/hls09-x.json", sourceCommit: HEAD, sourceTree: TREE, sourceContextClean: true,
  candidateTag: RELEASE_TAG, candidateImageId: RELEASE_IMAGE_ID, runImageId: RELEASE_IMAGE_ID,
});

describe("hls acceptance modes (the explicit boundary)", () => {
  it("names exactly two modes, and each mode's schema", () => {
    assert.deepEqual({ ...HLS_ACCEPTANCE_MODES }, { overlay: "overlay", releaseImage: "release-image" });
    assert.equal(HLS_ACCEPTANCE_MODE_FLAG, "--acceptance-mode");
    assert.deepEqual({ ...HLS_MODE_EVIDENCE_SCHEMAS }, {
      overlay: "hls08-deterministic-full-path-02",
      "release-image": "hls09-release-image-full-path-01",
    });
  });

  it("the HLS-08 overlay invocation names overlay mode explicitly, and parses to exactly HLS-08's identity", () => {
    const argv = orchestratorArgv(overlayDockerArgv(), OVERLAY_ID);
    assert.deepEqual(argv.slice(0, 2), ["--acceptance-mode", "overlay"]);
    assert.equal(argv.filter((a) => a === "--acceptance-mode").length, 1);
    assert.deepEqual(parseHlsAcceptanceArgv(argv), { ...OVERLAY_OPTS, evidence: `${HLS08_CONTAINER_REPORT_DIR}/hls08-x.json` });
  });

  it("the HLS-09 release invocation parses to exactly the parent's release identity, and nothing historical", () => {
    const parsed = parseHlsAcceptanceArgv(orchestratorArgv(releaseDockerArgv(), RELEASE_IMAGE_ID));
    assert.deepEqual(parsed, { ...RELEASE_OPTS, evidence: "/report/hls09-x.json" });
    for (const key of ["acceptedBaseSource", "baseImage", "baseDigest", "overlayImage", "overlayImageId", "overlayRuntimeCompatible"]) {
      assert.ok(!Object.hasOwn(parsed, key), `${key} is not a release-mode field`);
    }
  });

  it("the mode is required, given once, known, and never inferred from the identity flags", () => {
    const overlay = orchestratorArgv(overlayDockerArgv(), OVERLAY_ID);
    const noMode = overlay.slice(2);
    assert.throws(() => parseHlsAcceptanceArgv(noMode), /--acceptance-mode is required/);
    const release = orchestratorArgv(releaseDockerArgv(), RELEASE_IMAGE_ID);
    assert.throws(() => parseHlsAcceptanceArgv(release.slice(2)), /--acceptance-mode is required/,
      "release identity flags alone never select release mode");
    assert.throws(() => parseHlsAcceptanceArgv(["--acceptance-mode", "hls09", ...noMode]), /unknown --acceptance-mode/);
    assert.throws(() => parseHlsAcceptanceArgv(["--acceptance-mode", "overlay", ...overlay]), /may be given only once/);
    assert.throws(() => parseHlsAcceptanceArgv([...overlay, "--source-commit", HEAD]), /may be given only once/);
    assert.throws(() => parseHlsAcceptanceArgv([...overlay, "--family", "mp4"]), /unknown argument: --family/);
  });

  it("mixed identity fails closed in both directions, for every flag of the other mode", () => {
    const overlay = orchestratorArgv(overlayDockerArgv(), OVERLAY_ID);
    for (const extra of [["--candidate-tag", RELEASE_TAG], ["--candidate-image-id", RELEASE_IMAGE_ID], ["--run-image-id", RELEASE_IMAGE_ID]]) {
      assert.throws(() => parseHlsAcceptanceArgv([...overlay, ...extra]), /mixed acceptance identity: .* belongs to release-image mode/, extra[0]);
    }
    const release = orchestratorArgv(releaseDockerArgv(), RELEASE_IMAGE_ID);
    for (const extra of [
      ["--accepted-base-source", BASE_SOURCE], ["--base-image", BASE_IMAGE], ["--base-digest", BASE_DIGEST],
      ["--overlay-image", hlsOverlayImageTag(HEAD)], ["--overlay-image-id", OVERLAY_ID], ["--overlay-runtime-compatible"],
    ]) {
      assert.throws(() => parseHlsAcceptanceArgv([...release, ...extra]), /mixed acceptance identity: .* belongs to overlay mode/, extra[0]);
    }
  });

  it("each mode requires its own complete identity", () => {
    const release = orchestratorArgv(releaseDockerArgv(), RELEASE_IMAGE_ID);
    const drop = (argv, flag, withValue = true) => {
      const copy = [...argv];
      copy.splice(copy.indexOf(flag), withValue ? 2 : 1);
      return copy;
    };
    const swap = (argv, flag, value) => argv.map((x, i) => (argv[i - 1] === flag ? value : x));
    for (const flag of ["--candidate-tag", "--candidate-image-id", "--run-image-id"]) {
      assert.throws(() => parseHlsAcceptanceArgv(drop(release, flag)), new RegExp(`${flag} is required`));
    }
    assert.throws(() => parseHlsAcceptanceArgv(drop(release, "--evidence")), /--evidence <path> is required/);
    assert.throws(() => parseHlsAcceptanceArgv(drop(release, "--source-context-clean", false)), /not verified clean/);
    assert.throws(() => parseHlsAcceptanceArgv(swap(release, "--source-commit", HEAD.slice(0, 12))), /--source-commit must be the full/);
    assert.throws(() => parseHlsAcceptanceArgv(swap(release, "--source-tree", TREE.toUpperCase())), /--source-tree must be the full/);
    const overlay = orchestratorArgv(overlayDockerArgv(), OVERLAY_ID);
    assert.throws(() => parseHlsAcceptanceArgv(drop(overlay, "--overlay-runtime-compatible", false)), /runtime-compatible/);
    assert.throws(() => parseHlsAcceptanceArgv(swap(overlay, "--accepted-base-source", "593f47df")), /--accepted-base-source must be the full/);
    assert.throws(() => parseHlsAcceptanceArgv(drop(overlay, "--overlay-image-id")), /--overlay-image-id is required/);
  });
});

describe("hls acceptance identity checks", () => {
  const names = (entries) => entries.map((e) => e.name);
  const byName = (entries) => Object.fromEntries(entries.map((e) => [e.name, e.ok]));

  it("overlay mode records exactly HLS-08's four identity checks, unchanged", () => {
    const entries = acceptanceIdentityChecks(OVERLAY_OPTS, { networkInterfaceNames: ["lo", "eth0"] });
    assert.deepEqual(names(entries), [...HLS08_OVERLAY_IDENTITY_CHECKS]);
    assert.deepEqual(HLS08_MANDATORY_CHECKS.slice(0, 4), [...HLS08_OVERLAY_IDENTITY_CHECKS]);
    assert.ok(entries.every((e) => e.ok === true && e.detail === null));
    const bad = byName(acceptanceIdentityChecks({ ...OVERLAY_OPTS, baseDigest: RELEASE_IMAGE_ID, overlayImageId: RELEASE_IMAGE_ID }));
    assert.equal(bad["image/accepted-base-digest-is-the-recorded-runtime"], false);
    assert.equal(bad["image/overlay-is-non-deployable"], false);
  });

  it("release mode records the release identity and NO historical-base or overlay assertion", () => {
    const entries = acceptanceIdentityChecks(RELEASE_OPTS, { networkInterfaceNames: ["lo"] });
    assert.deepEqual(names(entries), [...HLS09_RELEASE_IDENTITY_CHECKS]);
    assert.ok(entries.every((e) => e.ok === true), JSON.stringify(entries));
    for (const overlayCheck of HLS08_OVERLAY_IDENTITY_CHECKS) {
      assert.ok(!names(entries).includes(overlayCheck));
      assert.ok(!HLS09_MANDATORY_CHECKS.includes(overlayCheck), `${overlayCheck} is not required in release mode`);
    }
    assert.equal(entries.find((e) => e.name === "release/network-namespace-is-loopback-only").detail, "lo");
  });

  it("each release identity check fails on its own fault", () => {
    const failing = (opts, interfaces = ["lo"]) =>
      acceptanceIdentityChecks({ ...RELEASE_OPTS, ...opts }, { networkInterfaceNames: interfaces }).filter((e) => !e.ok).map((e) => e.name);
    assert.deepEqual(failing({ sourceCommit: HEAD.slice(0, 12) }), ["release/source-identity-present", "release/candidate-label-is-non-production"]);
    assert.deepEqual(failing({ sourceTree: null }), ["release/source-identity-present"]);
    assert.deepEqual(failing({ sourceContextClean: false }), ["release/source-context-clean"]);
    assert.deepEqual(failing({ candidateImageId: "sha256:abc", runImageId: "sha256:abc" }), [
      "release/candidate-image-id-valid", "release/run-subject-is-candidate-image-id",
    ]);
    assert.deepEqual(failing({ runImageId: OVERLAY_ID }), ["release/run-subject-is-candidate-image-id"]);
    assert.deepEqual(failing({ runImageId: RELEASE_TAG }), ["release/run-subject-is-candidate-image-id"]);
    for (const label of ["videofetch-worker:latest", "videofetch-worker:rc-0123456789ab-cccccccccccc", candidateImageTag(TREE), hlsOverlayImageTag(HEAD)]) {
      assert.deepEqual(failing({ candidateTag: label }), ["release/candidate-label-is-non-production"], label);
    }
    for (const interfaces of [["lo", "eth0"], ["eth0"], [], null]) {
      assert.deepEqual(failing({}, interfaces), ["release/network-namespace-is-loopback-only"], String(JSON.stringify(interfaces)));
    }
    assert.throws(() => acceptanceIdentityChecks({ ...RELEASE_OPTS, mode: "both" }), /unknown acceptance mode/);
  });
});

describe("hls release-image evidence (hls09-release-image-full-path-01)", () => {
  /** The behavioral blocks alone — what the orchestrator measures in either mode. */
  function behavioral(checks) {
    const { source: _source, image: _image, ...rest } = evidenceInput(checks ? { checks } : {});
    return rest;
  }
  const releasePassing = () => HLS09_MANDATORY_CHECKS.map((name) => ({ name, ok: true, detail: null }));
  const observed = { networkInterfaceNames: ["lo"] };

  /** Every key anywhere in a document. */
  function allKeys(value, out = new Set()) {
    if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        allKeys(v, out);
      }
    }
    return out;
  }

  it("overlay mode still produces HLS-08 -02, byte-identical to the HLS-08 builder", () => {
    const viaMode = buildAcceptanceEvidence(OVERLAY_OPTS, behavioral());
    const direct = buildHlsEvidence(evidenceInput({
      source: {
        commit: HEAD, tree: TREE, contextClean: true, acceptedBaseSourceCommit: BASE_SOURCE,
        overlayRuntimeCompatibilityVerified: true,
      },
      image: {
        acceptedBaseImage: BASE_IMAGE, acceptedBaseDigest: BASE_DIGEST,
        overlayImage: hlsOverlayImageTag(HEAD), overlayImageId: OVERLAY_ID,
      },
    }));
    assert.equal(viaMode.schema, "hls08-deterministic-full-path-02");
    assert.equal(renderAcceptanceEvidence(OVERLAY_OPTS, viaMode), renderHlsEvidence(direct));
    assert.deepEqual(imageRemovalFact(OVERLAY_OPTS), { overlayRemovedBy: "run-hls-acceptance.mjs unless --keep-image" });
  });

  it("release mode produces HLS-09 -01 with release identity and no historical-base or overlay field", () => {
    const record = buildAcceptanceEvidence(RELEASE_OPTS, behavioral(releasePassing()), observed);
    assert.equal(record.schema, HLS09_RELEASE_EVIDENCE_SCHEMA);
    assert.equal(record.schema, "hls09-release-image-full-path-01");
    assert.equal(record.verdict, "PASS");
    assert.deepEqual(record.source.commit, HEAD);
    assert.equal(record.source.contextClean, true);
    assert.equal(record.image.candidateTag, RELEASE_TAG);
    assert.equal(record.image.imageId, RELEASE_IMAGE_ID);
    assert.equal(record.image.runSubject, RELEASE_IMAGE_ID);
    assert.equal(record.image.deployable, false);
    assert.equal(record.network.mode, "none");
    assert.deepEqual(record.network.observedInterfaceNames, ["lo"]);
    const keys = allKeys(record);
    for (const key of ["acceptedBaseImage", "acceptedBaseDigest", "acceptedBaseSourceCommit", "overlayImage", "overlayImageId", "overlayRuntimeCompatibilityVerified", "runtimeCompatibilityFiles"]) {
      assert.ok(!keys.has(key), `${key} must not appear in a release record`);
    }
    assert.deepEqual(record.nonClaims, [...HLS09_NON_CLAIMS]);
    assert.ok(record.nonClaims.some((c) => /Production egress\/nftables is NOT re-proven/.test(c)));
    assert.ok(record.nonClaims.some((c) => /Production DNS is NOT re-proven/.test(c)));
    assert.ok(record.nonClaims.some((c) => /Cloudflare Tunnel\/Access, Vercel, Cloudflare R2 or R2 credential broker/.test(c)));
    assert.ok(record.nonClaims.some((c) => /public HLS source compatibility/.test(c)));
    assert.ok(record.nonClaims.some((c) => /no Production startup of this candidate/.test(c)));
    assert.match(record.substitutions.safeHttpTransport, /NOT Production DNS, address-pinning or egress/);
    assert.deepEqual(imageRemovalFact(RELEASE_OPTS), { candidateRemovedBy: "run-release-image-acceptance.mjs unless --keep-image" });
    assert.deepEqual(
      validateHlsReleaseChildRecord(JSON.parse(renderAcceptanceEvidence(RELEASE_OPTS, record)), {
        sourceCommit: HEAD, sourceTree: TREE, candidateTag: RELEASE_TAG, candidateImageId: RELEASE_IMAGE_ID,
      }),
      [],
    );
  });

  it("a release PASS does not require the historical accepted-base identity, and the overlay ledger cannot earn it", () => {
    assert.equal(HLS09_MANDATORY_CHECKS.length, HLS09_RELEASE_IDENTITY_CHECKS.length + HLS_BEHAVIORAL_MANDATORY_CHECKS.length);
    assert.deepEqual(HLS09_MANDATORY_CHECKS.slice(HLS09_RELEASE_IDENTITY_CHECKS.length), [...HLS_BEHAVIORAL_MANDATORY_CHECKS]);
    assert.equal(buildAcceptanceEvidence(RELEASE_OPTS, behavioral(releasePassing()), observed).verdict, "PASS");
    // HLS-08's complete PASS ledger lacks the release identity: no release PASS.
    assert.throws(
      () => buildAcceptanceEvidence(RELEASE_OPTS, behavioral(passingChecks()), observed),
      /refusing to emit a PASS hls09-release-image-full-path-01 record: release\/source-identity-present: recorded 0 times/,
    );
  });

  it("a release PASS still requires every behavioral check and every release identity check, exactly once", () => {
    for (const name of HLS09_MANDATORY_CHECKS) {
      const dropped = releasePassing().filter((c) => c.name !== name);
      assert.throws(() => buildHlsReleaseEvidenceFor(dropped), /refusing to emit a PASS/, `absent ${name}`);
      const failed = releasePassing().map((c) => (c.name === name ? { ...c, ok: false } : c));
      assert.throws(() => buildHlsReleaseEvidenceFor(failed), /refusing to emit a PASS/, `failed ${name}`);
    }
    const duplicated = [...releasePassing(), releasePassing()[10]];
    assert.throws(() => buildHlsReleaseEvidenceFor(duplicated), /recorded 2 times/);
    const extraFailed = [...releasePassing(), { name: "extra/x", ok: false, detail: null }];
    assert.throws(() => buildHlsReleaseEvidenceFor(extraFailed), /extra\/x: failed/);
    // A FAIL is still emittable, so a release failure is reportable.
    assert.equal(buildHlsReleaseEvidenceFor(releasePassing().slice(1), "FAIL").verdict, "FAIL");
    assert.throws(() => buildHlsReleaseEvidenceFor(releasePassing(), "MAYBE"), /PASS, FAIL or BLOCKED/);

    function buildHlsReleaseEvidenceFor(checks, verdict = "PASS") {
      return buildAcceptanceEvidence(RELEASE_OPTS, { ...behavioral(checks), verdict }, observed);
    }
  });

  it("records the run subject the parent handed over, never a copy of the candidate id", () => {
    const opts = { ...RELEASE_OPTS, runImageId: OVERLAY_ID };
    const checks = acceptanceIdentityChecks(opts, observed);
    assert.equal(checks.find((c) => c.name === "release/run-subject-is-candidate-image-id").ok, false);
    const record = buildAcceptanceEvidence(opts, { ...behavioral([...checks, ...releasePassing().slice(6)]), verdict: "FAIL" }, observed);
    assert.equal(record.image.imageId, RELEASE_IMAGE_ID);
    assert.equal(record.image.runSubject, OVERLAY_ID, "a mismatch must be visible in the record, never papered over");
    assert.ok(
      validateHlsReleaseChildRecord(record, {
        sourceCommit: HEAD, sourceTree: TREE, candidateTag: RELEASE_TAG, candidateImageId: RELEASE_IMAGE_ID,
      }).includes("run image id is not the parent's candidate id"),
    );
  });

  it("the PASS gate names exactly the unmet release check, once", () => {
    const failed = releasePassing().map((c) => (c.name === "release/source-context-clean" ? { ...c, ok: false } : c));
    assert.deepEqual(unmetPassConditions(failed, HLS09_MANDATORY_CHECKS), ["release/source-context-clean: failed"]);
    assert.deepEqual(unmetPassConditions(releasePassing(), HLS09_MANDATORY_CHECKS), []);
    // The default ledger is still HLS-08's.
    assert.deepEqual(unmetPassConditions(passingChecks()), []);
  });

  it("a release record refuses unverified source identity, PASS or FAIL", () => {
    for (const verdict of ["PASS", "FAIL"]) {
      for (const opts of [
        { sourceCommit: HEAD.slice(0, 12) }, { sourceTree: "x" }, { sourceContextClean: false },
      ]) {
        assert.throws(
          () => buildAcceptanceEvidence({ ...RELEASE_OPTS, ...opts }, { ...behavioral(releasePassing()), verdict }, observed),
          /without parent-verified release source identity/,
          `${verdict} ${JSON.stringify(opts)}`,
        );
      }
    }
  });

  it("release record privacy stays fail-closed: the same leaks, keys and placements as HLS-08 -02", () => {
    const leaks = [
      HLS08_PRIVATE_MARKERS.execution, HLS08_PRIVATE_MARKERS.browser, HLS08_RAW_FORMAT_ID, HLS_FIXTURE_HOSTNAME,
      "http://anything.example/x", "sig=abc",
      "/tmp/videofetch/jobs/x/hls-source.ts", "media.m3u8",
    ];
    const build = (extra) => buildHlsReleaseEvidence({
      ...behavioral(releasePassing()),
      source: { commit: HEAD, tree: TREE, contextClean: true },
      image: { candidateTag: RELEASE_TAG, imageId: RELEASE_IMAGE_ID, runSubject: RELEASE_IMAGE_ID },
      network: { fixtureBind: HLS_FIXTURE_LOOPBACK, fixturePort: 40123, observedInterfaceNames: ["lo"] },
      ...extra,
    });
    assert.equal(build({}).verdict, "PASS");
    for (const leak of leaks) {
      assert.throws(() => build({ hls2: { note: leak } }), /private HLS material/, leak);
      assert.throws(() => build({ fixture: { deep: [{ x: leak }] } }), /private HLS material/, leak);
      assert.throws(() => build({ image: { candidateTag: leak, imageId: RELEASE_IMAGE_ID, runSubject: RELEASE_IMAGE_ID } }), /private HLS material/, leak);
    }
    for (const key of ["stderr", "stdout", "argv", "playlistUrl", "fragmentUrl", "cookie", "authorization", "secret", "credential", "token", "url", "headers"]) {
      assert.throws(() => build({ hls3: { [key]: 1 } }), /containing a/, key);
    }
    // A leak is refused even in a FAIL record: privacy is not a PASS-only gate.
    assert.throws(() => build({ verdict: "FAIL", hls2: { note: HLS_FIXTURE_HOSTNAME } }), /private HLS material/);
  });
});
