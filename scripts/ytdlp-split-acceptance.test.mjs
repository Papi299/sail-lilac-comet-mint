// Self-tests for the SPLIT-06 deterministic split-stream acceptance harness.
//
// These prove the HARNESS, not the product. They spawn no container, no
// FFmpeg, no ffprobe and no yt-dlp, and they reach no network: everything here
// is pure argv/document construction, a loopback HTTP fixture, or the REAL
// upload lifecycle over an in-memory SQLite store. The one subprocess any of
// them starts is `git`, in a throwaway repository, to prove the provenance gate
// against Git's real output. The full-path acceptance itself is a separate,
// explicitly invoked run -- `deploy/acceptance/ytdlp-generic/run-split-acceptance.mjs`.
//
// One runtime requirement: `lib/local-object-writer.mjs` and the lifecycle
// suite import the REAL TypeScript source, because conforming to the real
// interfaces is the whole point. Node 22.18+ strips types without a flag,
// which is what this repository's Worker image runs.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createFixtureService,
  LISTEN_ADDRESS,
  PHASE_10D_ROUTES,
  readSingleByteRange,
  SPLIT_MANIFEST_ROUTES,
  SPLIT_MEDIA_ROUTES,
  SPLIT_ROUTE_CONTENT_TYPES,
} from "../deploy/acceptance/ytdlp-generic/fixtures/server.mjs";
import {
  SPLIT_FAMILIES,
  SPLIT_FIXTURE_ARTIFACTS,
  SPLIT_FIXTURE_MAX_BYTES,
  SPLIT_SYNTHETIC_FORMAT_IDS,
  SPLIT_TARGET_CONTAINER,
  SPLIT_TARGET_MIME,
  generateSplitFixtures,
  splitDockerArgs,
  splitFfmpegArgs,
  splitIncompatibleManifest,
  splitManifest,
} from "../deploy/acceptance/ytdlp-generic/fixtures/split-media.mjs";
import { createExactFixtureUrlValidator } from "../deploy/acceptance/ytdlp-generic/lib/split-fixture-url.mjs";
import { createLocalObjectStoreWriter } from "../deploy/acceptance/ytdlp-generic/lib/local-object-writer.mjs";
import {
  acceptanceRunArgs,
  FORBIDDEN_OVERLAY_TAGS,
  OVERLAY_COPIED_PATHS,
  overlayBuildArgs,
  overlayDockerfile,
  overlayImageTag,
} from "../deploy/acceptance/ytdlp-generic/lib/split-container.mjs";
import {
  OVERLAY_RUNTIME_COMPATIBILITY_FILES,
  ProvenanceError,
  verifyOverlayContextProvenance,
} from "../deploy/acceptance/ytdlp-generic/lib/split-provenance.mjs";
import {
  parseArgv as parseDriverArgv,
  runSplitAcceptance,
} from "../deploy/acceptance/ytdlp-generic/run-split-acceptance.mjs";
import { finalizeJobUpload } from "../src/worker/storage/upload-lifecycle.server.ts";
import { SQLiteJobStore } from "../src/worker/state/sqlite-job-store.server.ts";
import { openWorkerDatabase } from "../src/worker/state/database.server.ts";
import { applyMigrations } from "../src/worker/state/migrations.server.ts";
import {
  buildSplitEvidence,
  CHUNKED_REFUSAL_CHUNK_SIZE_SOURCE,
  CHUNKED_REFUSAL_HARNESS_ARGUMENT,
  evaluateChunkedMaxFilesizeRefusal,
  evaluateMaxFilesizeRefusal,
  MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  renderSplitEvidence,
  SPLIT06_EVIDENCE_SCHEMA,
  SPLIT06_FORBIDDEN_EVIDENCE_SUBSTRINGS,
} from "../deploy/acceptance/ytdlp-generic/lib/split-evidence.mjs";
import {
  createRunnerLedger,
  MEDIA_TOOL_BASENAMES,
} from "../deploy/acceptance/ytdlp-generic/lib/split-observers.mjs";

const HEAD = "b8f514e2916d1e323518f21fa1e272165ef3fdf4";
const TREE = "779d5a21d8e4ef835831a2d53e93c4e9ea43009c";
const ACCEPTED_BASE_SOURCE = "e4fa646bf7492e16fc8d2733982f708a1e243afb";

// Small, obviously-not-media stand-ins. These tests never decode anything, so a
// real encode would only make them slow and dependent on FFmpeg.
const bodyFor = (name) => Buffer.from(`SPLIT-06 stand-in body for ${name}\n`, "utf8");

function splitSet() {
  const manifests = {
    "/split-mp4.mpd": Buffer.from(splitManifest("mp4"), "utf8"),
    "/split-webm.mpd": Buffer.from(splitManifest("webm"), "utf8"),
    "/split-incompatible.mpd": Buffer.from(splitIncompatibleManifest(), "utf8"),
  };
  const artifacts = {};
  for (const route of SPLIT_MEDIA_ROUTES) artifacts[route] = bodyFor(route);
  return { manifests, artifacts };
}

const started = [];
async function startSplitFixture(overrides = {}) {
  const service = createFixtureService({ split: splitSet(), ...overrides });
  const address = await service.listen(0);
  started.push(service);
  return { service, address, base: `http://${LISTEN_ADDRESS}:${address.port}` };
}

after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

// -- fixture recipes --------------------------------------------------------

describe("split fixture: generation recipes", () => {
  it("declares four artifacts, one per family and role", () => {
    assert.deepEqual(Object.keys(SPLIT_FIXTURE_ARTIFACTS).sort(), [
      "mp4:audio",
      "mp4:video",
      "webm:audio",
      "webm:video",
    ]);
    assert.deepEqual([...SPLIT_FAMILIES], ["mp4", "webm"]);
  });

  it("gives every half exactly ONE declared stream", () => {
    for (const artifact of Object.values(SPLIT_FIXTURE_ARTIFACTS)) {
      const total = artifact.streams.video + artifact.streams.audio;
      assert.equal(total, 1, `${artifact.basename} must carry exactly one stream`);
      if (artifact.role === "video") assert.equal(artifact.streams.video, 1);
      else assert.equal(artifact.streams.audio, 1);
    }
  });

  it("refuses the second stream at the recipe level, not merely by omission", () => {
    // `-an` / `-vn` is what makes "exactly one stream" a property of the
    // command rather than of the input happening to have no other track.
    assert.ok(splitFfmpegArgs("mp4", "video", "/out/x.mp4").includes("-an"));
    assert.ok(splitFfmpegArgs("webm", "video", "/out/x.webm").includes("-an"));
    assert.ok(splitFfmpegArgs("mp4", "audio", "/out/x.m4a").includes("-vn"));
    assert.ok(splitFfmpegArgs("webm", "audio", "/out/x.webm").includes("-vn"));
  });

  it("pins the determinism levers on every recipe", () => {
    for (const artifact of Object.values(SPLIT_FIXTURE_ARTIFACTS)) {
      const recipe = splitFfmpegArgs(artifact.family, artifact.role, "/out/x").join(" ");
      assert.match(recipe, /-fflags \+bitexact/, artifact.basename);
      assert.match(recipe, /-map_metadata -1/, artifact.basename);
      // lavfi only: nothing is fetched, and no external media is involved.
      assert.ok(!/https?:/.test(recipe), "a recipe must not reference a URL");
      assert.match(recipe, /-f lavfi/);
    }
    // Both video encoders' output is a function of their thread count, which is
    // otherwise derived from the host CPU count.
    assert.match(splitFfmpegArgs("mp4", "video", "/o").join(" "), /-threads 1/);
    assert.match(splitFfmpegArgs("webm", "video", "/o").join(" "), /-threads 1/);
  });

  it("chooses the muxer explicitly rather than by filename extension", () => {
    assert.match(splitFfmpegArgs("mp4", "video", "/o").join(" "), /-f mp4 \/o$/);
    assert.match(splitFfmpegArgs("mp4", "audio", "/o").join(" "), /-f ipod \/o$/);
    assert.match(splitFfmpegArgs("webm", "video", "/o").join(" "), /-f webm \/o$/);
    assert.match(splitFfmpegArgs("webm", "audio", "/o").join(" "), /-f webm \/o$/);
  });

  it("keeps the halves small enough to stay a correctness fixture", () => {
    assert.equal(SPLIT_FIXTURE_MAX_BYTES, 2 * 1024 * 1024);
    for (const artifact of Object.values(SPLIT_FIXTURE_ARTIFACTS)) {
      assert.equal(artifact.durationSeconds, 2);
    }
  });

  it("regenerates a half with no network", () => {
    const argv = splitDockerArgs({
      image: "videofetch-worker:test",
      outDir: "/out",
      family: "mp4",
      role: "video",
    }).join(" ");
    assert.match(argv, /--network none/);
    assert.match(argv, /--entrypoint \/usr\/bin\/ffmpeg/);
    assert.match(argv, /split-video\.mp4/);
  });

  it("computes each half's digest from the produced file and refuses duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "split06-gen-"));
    try {
      // A fake `run` that writes DISTINCT deterministic bodies.
      const distinct = await generateSplitFixtures({
        ffmpegPath: "/usr/bin/ffmpeg",
        outDir: dir,
        run: async (_cmd, args) => {
          const out = args[args.length - 1];
          await writeFile(out, `body:${out}\n`);
        },
      });
      for (const [key, artifact] of Object.entries(distinct)) {
        const bytes = await readFile(artifact.path);
        assert.equal(
          artifact.sha256,
          createHash("sha256").update(bytes).digest("hex"),
          `${key} digest must describe the produced file`,
        );
        assert.equal(artifact.byteLength, bytes.byteLength);
      }

      // ...and a `run` that writes the SAME body everywhere is refused: four
      // identical halves would turn a pair proof into a self-comparison.
      await assert.rejects(
        generateSplitFixtures({
          ffmpegPath: "/usr/bin/ffmpeg",
          outDir: dir,
          run: async (_cmd, args) => {
            await writeFile(args[args.length - 1], "identical\n");
          },
        }),
        /must all be distinct/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -- the manifests ----------------------------------------------------------

describe("split fixture: DASH manifests", () => {
  it("declares one video and one audio representation, statically", () => {
    for (const family of SPLIT_FAMILIES) {
      const doc = splitManifest(family);
      assert.match(doc, /type="static"/, "a live manifest would be refused by the product");
      assert.equal(doc.match(/<Representation /g).length, 2);
      assert.equal(doc.match(/<AdaptationSet /g).length, 2);
      assert.match(doc, /contentType="video"/);
      assert.match(doc, /contentType="audio"/);
    }
  });

  it("names each half with its synthetic, safe-grammar identifier", () => {
    const doc = splitManifest("mp4");
    assert.match(doc, new RegExp(`id="${SPLIT_SYNTHETIC_FORMAT_IDS.video}"`));
    assert.match(doc, new RegExp(`id="${SPLIT_SYNTHETIC_FORMAT_IDS.audio}"`));
    for (const id of Object.values(SPLIT_SYNTHETIC_FORMAT_IDS)) {
      // Must satisfy the product's safe internal format-id grammar, or the
      // candidate would not be executable at all.
      assert.match(id, /^[A-Za-z0-9._-]{1,128}$/);
    }
  });

  it("references its media RELATIVELY, so no request input can steer it", () => {
    for (const doc of [splitManifest("mp4"), splitManifest("webm"), splitIncompatibleManifest()]) {
      const baseUrls = [...doc.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map((m) => m[1]);
      assert.equal(baseUrls.length, 2);
      for (const url of baseUrls) {
        assert.ok(!url.includes("://"), `${url} must be relative`);
        assert.ok(!url.startsWith("/"), `${url} must be relative`);
      }
    }
  });

  it("pairs each family's declared codecs with its declared container", () => {
    assert.match(splitManifest("mp4"), /mimeType="video\/mp4"[\s\S]*codecs="avc1\.42E01E"/);
    assert.match(splitManifest("mp4"), /mimeType="audio\/mp4"[\s\S]*codecs="mp4a\.40\.2"/);
    assert.match(splitManifest("webm"), /mimeType="video\/webm"[\s\S]*codecs="vp9"/);
    assert.match(splitManifest("webm"), /mimeType="audio\/webm"[\s\S]*codecs="opus"/);
  });

  it("makes the incompatible manifest genuinely cross-family", () => {
    const doc = splitIncompatibleManifest();
    assert.match(doc, /mimeType="video\/mp4"/);
    assert.match(doc, /mimeType="audio\/webm"/);
    // Both halves individually fine; only the COMBINATION is refused, which is
    // what makes the negative case about the closed table rather than about a
    // malformed fixture.
    assert.match(doc, /<BaseURL>split-video\.mp4<\/BaseURL>/);
    assert.match(doc, /<BaseURL>split-audio\.webm<\/BaseURL>/);
  });

  it("agrees with the closed product target table", () => {
    assert.deepEqual({ ...SPLIT_TARGET_CONTAINER }, { mp4: "mp4", webm: "webm" });
    assert.deepEqual({ ...SPLIT_TARGET_MIME }, { mp4: "video/mp4", webm: "video/webm" });
  });
});

// -- the fixture service ----------------------------------------------------

describe("split fixture service: exposure surface", () => {
  let fx;
  before(async () => {
    fx = await startSplitFixture();
  });

  it("binds loopback only", () => {
    assert.equal(fx.address.address, "127.0.0.1");
    assert.notEqual(fx.address.address, "0.0.0.0");
    assert.notEqual(fx.address.address, "::");
  });

  it("serves every declared split route and nothing else", async () => {
    for (const route of [...SPLIT_MANIFEST_ROUTES, ...SPLIT_MEDIA_ROUTES]) {
      const res = await fetch(`${fx.base}${route}`);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get("content-type"), SPLIT_ROUTE_CONTENT_TYPES[route], route);
      assert.equal(res.headers.get("accept-ranges"), "none", route);
      const body = await res.text();
      assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(body)), route);
    }
  });

  it("404s the Phase-10D routes when only the split set is configured", async () => {
    for (const route of PHASE_10D_ROUTES) {
      const res = await fetch(`${fx.base}${route}`);
      assert.equal(res.status, 404, `${route} belongs to a set this instance does not serve`);
    }
  });

  it("maps no request string to a filesystem read", async () => {
    const traversals = [
      "/split-video.mp4/../../etc/passwd",
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/split-video.mp4%00.txt",
      "/deploy/acceptance/ytdlp-generic/split-full-path.mjs",
      "/proc/self/environ",
      "/split-mp4.mpd.bak",
      "/split-audio.mp3",
    ];
    for (const route of traversals) {
      const res = await fetch(`${fx.base}${route}`, { redirect: "manual" });
      assert.equal(res.status, 404, `${route} must not resolve to a file`);
      assert.equal((await res.text()).trim(), "not found");
    }
  });

  it("405s unsupported methods on every split route", async () => {
    for (const route of [...SPLIT_MANIFEST_ROUTES, ...SPLIT_MEDIA_ROUTES]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await fetch(`${fx.base}${route}`, { method });
        assert.equal(res.status, 405, `${method} ${route}`);
        assert.match(res.headers.get("allow") ?? "", /GET/);
      }
    }
  });

  it("records a sanitized request log and nothing else", async () => {
    const fixture = await startSplitFixture();
    await fetch(`${fixture.base}/split-mp4.mpd`);
    await fetch(`${fixture.base}/split-video.mp4`, { method: "HEAD" });
    const requests = fixture.service.splitRequests();
    assert.equal(requests.length, 2);
    assert.deepEqual(Object.keys(requests[0]).sort(), ["at", "bytes", "method", "route"]);
    assert.equal(requests[0].route, "/split-mp4.mpd");
    // A HEAD serves no body, and the log says so rather than inventing a count.
    assert.equal(requests[1].method, "HEAD");
    assert.equal(requests[1].bytes, 0);
  });

  it("reports the split set in the manifest with per-route digests", async () => {
    const manifest = fx.service.manifest();
    assert.equal(manifest.splitConfigured, true);
    assert.deepEqual(manifest.splitManifestPaths, [...SPLIT_MANIFEST_ROUTES]);
    assert.deepEqual(manifest.splitMediaPaths, [...SPLIT_MEDIA_ROUTES]);
    for (const route of SPLIT_MEDIA_ROUTES) {
      assert.match(manifest.splitSha256[route], /^[0-9a-f]{64}$/);
      assert.equal(manifest.splitBytes[route], bodyFor(route).byteLength);
    }
    const serialized = JSON.stringify(manifest).toLowerCase();
    for (const forbidden of [
      "secret",
      "token",
      "password",
      "credential",
      "authorization",
      "cookie",
    ]) {
      assert.ok(!serialized.includes(forbidden));
    }
  });

  it("refuses a partial or undeclared split set", () => {
    const set = splitSet();
    delete set.artifacts["/split-audio.m4a"];
    assert.throws(
      () => createFixtureService({ split: set }),
      /split artifact for \/split-audio\.m4a/,
    );

    const extra = splitSet();
    extra.artifacts["/split-extra.mp4"] = bodyFor("extra");
    assert.throws(
      () => createFixtureService({ split: extra }),
      /not a declared split artifact route/,
    );

    assert.throws(
      () => createFixtureService({ split: { manifests: {} } }),
      /must supply an `artifacts` map/,
    );
  });

  it("leaves the Phase-10D contract exactly as it was", () => {
    // Naming either buffer still requires both, with the original messages.
    assert.throws(
      () => createFixtureService({ media: Buffer.alloc(0), genericMedia: bodyFor("g") }),
      /direct fixture media must be a non-empty Buffer/,
    );
    assert.throws(
      () => createFixtureService({ media: bodyFor("d") }),
      /generic fixture media must be a non-empty Buffer/,
    );
    // ...and a service configured with nothing at all is still refused.
    assert.throws(() => createFixtureService({}), /direct fixture media must be a non-empty Buffer/);
  });
});

// -- the opt-in RANGED split instance (the chunked --max-filesize case only) --

describe("split fixture service: the opt-in ranged instance", () => {
  it("reads exactly one byte range, and nothing it cannot honour", () => {
    assert.deepEqual(readSingleByteRange("bytes=0-99", 1000), { satisfiable: true, start: 0, end: 99 });
    assert.deepEqual(readSingleByteRange("bytes=900-", 1000), { satisfiable: true, start: 900, end: 999 });
    assert.deepEqual(readSingleByteRange("bytes=900-5000", 1000), { satisfiable: true, start: 900, end: 999 });
    assert.deepEqual(readSingleByteRange("bytes=1000-", 1000), { satisfiable: false });
    assert.deepEqual(readSingleByteRange("bytes=1000-2000", 1000), { satisfiable: false });
    for (const ignored of [
      undefined,
      "",
      "bytes=-100",
      "bytes=0-1,5-9",
      "bytes=9-3",
      "items=0-1",
      "bytes=0x1-2",
      "bytes= 0-1",
      `bytes=${"9".repeat(16)}-`,
    ]) {
      assert.equal(readSingleByteRange(ignored, 1000), null, String(ignored));
    }
  });

  it("is OFF by default: every split route stays whole-object, Range header or not", async () => {
    const fx = await startSplitFixture();
    const res = await fetch(`${fx.base}/split-video.mp4`, { headers: { range: "bytes=0-3" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("accept-ranges"), "none");
    assert.equal(Buffer.from(await res.arrayBuffer()).byteLength, bodyFor("/split-video.mp4").byteLength);
    // The default instance's log is exactly what it always was.
    assert.deepEqual(Object.keys(fx.service.splitRequests()[0]).sort(), ["at", "bytes", "method", "route"]);
    assert.equal(fx.service.manifest().splitMediaRanges, "none");
  });

  it("serves one range per media request, 416 past the end, and never a range of a manifest", async () => {
    const set = splitSet();
    const fx = await startSplitFixture({ split: { ...set, ranges: true } });
    const body = bodyFor("/split-audio.m4a");

    const part = await fetch(`${fx.base}/split-audio.m4a`, { headers: { range: "bytes=2-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 2-9/${body.byteLength}`);
    assert.equal(part.headers.get("content-length"), "8");
    assert.equal(part.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), body.subarray(2, 10));

    const past = await fetch(`${fx.base}/split-audio.m4a`, { headers: { range: `bytes=${body.byteLength}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${body.byteLength}`);
    await past.arrayBuffer();

    const whole = await fetch(`${fx.base}/split-audio.m4a`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    await whole.arrayBuffer();

    const manifest = await fetch(`${fx.base}/split-mp4.mpd`, { headers: { range: "bytes=0-3" } });
    assert.equal(manifest.status, 200, "a manifest never answers a range");
    assert.equal(manifest.headers.get("accept-ranges"), "none");
    await manifest.arrayBuffer();

    assert.deepEqual(
      fx.service.splitRequests().map((r) => [r.route, r.status, r.bytes, r.range]),
      [
        ["/split-audio.m4a", 206, 8, { start: 2, end: 9, total: body.byteLength }],
        ["/split-audio.m4a", 416, 0, null],
        ["/split-audio.m4a", 200, body.byteLength, null],
        ["/split-mp4.mpd", 200, set.manifests["/split-mp4.mpd"].byteLength, null],
      ],
    );
    assert.equal(fx.service.manifest().splitMediaRanges, "single byte range");
  });

  it("refuses a `ranges` that is not a boolean", () => {
    assert.throws(
      () => createFixtureService({ split: { ...splitSet(), ranges: "yes" } }),
      /`ranges` must be a boolean/,
    );
  });
});

// -- the exact-fixture URL validator ----------------------------------------

describe("split acceptance: exact-fixture URL validator", () => {
  const port = 45999;
  const routes = ["/split-mp4.mpd", "/split-video.mp4", "/split-audio.m4a"];
  const validate = createExactFixtureUrlValidator({ port, routes });

  it("admits exactly the declared fixture URLs", async () => {
    for (const route of routes) {
      const result = await validate(`http://127.0.0.1:${port}${route}`);
      assert.equal(result.url, `http://127.0.0.1:${port}${route}`);
      assert.equal(result.hostname, "127.0.0.1");
    }
  });

  it("refuses everything else -- no wildcard loopback, no private address", async () => {
    const refused = [
      `http://127.0.0.1:${port + 1}/split-mp4.mpd`,
      `http://127.0.0.2:${port}/split-mp4.mpd`,
      `http://localhost:${port}/split-mp4.mpd`,
      `http://[::1]:${port}/split-mp4.mpd`,
      `http://10.0.0.1:${port}/split-mp4.mpd`,
      `http://192.168.1.1:${port}/split-mp4.mpd`,
      `http://169.254.169.254:${port}/split-mp4.mpd`,
      `https://127.0.0.1:${port}/split-mp4.mpd`,
      "file:///split-mp4.mpd",
      "data:text/plain,x",
      `http://127.0.0.1:${port}/etc/passwd`,
      `http://127.0.0.1:${port}/split-video.webm`,
      `http://127.0.0.1:${port}/split-mp4.mpd?a=1`,
      `http://127.0.0.1:${port}/split-mp4.mpd#f`,
      `http://u:p@127.0.0.1:${port}/split-mp4.mpd`,
      "http://example.com/split-mp4.mpd",
      "",
      "not a url",
    ];
    for (const candidate of refused) {
      await assert.rejects(
        () => validate(candidate),
        (err) => err.code === "INVALID_URL",
        candidate,
      );
    }
  });

  it("refuses to be built from a wildcard route", () => {
    assert.throws(() => createExactFixtureUrlValidator({ port, routes: ["/*"] }), /exact path/);
    assert.throws(() => createExactFixtureUrlValidator({ port, routes: [] }), /exact route set/);
    assert.throws(() => createExactFixtureUrlValidator({ port: 0, routes }), /exact bound port/);
  });

  it("builds a URL only for a declared route", () => {
    assert.equal(validate.urlFor("/split-mp4.mpd"), `http://127.0.0.1:${port}/split-mp4.mpd`);
    assert.throws(() => validate.urlFor("/nope"), /not a declared fixture route/);
  });
});

// -- the local object writer ------------------------------------------------

describe("split acceptance: local ObjectStoreWriter", () => {
  const key = (jobId) => `videofetch/jobs/${jobId}/${"a".repeat(32)}`;
  const jobId = "f".repeat(32);
  const putInput = (body, overrides = {}) => ({
    objectKey: key(jobId),
    body,
    contentLength: 3,
    contentType: "video/mp4",
    contentDisposition: 'attachment; filename="x.mp4"',
    ...overrides,
  });
  async function* stream(...chunks) {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }

  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "split06-sink-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records the exact byte count and digest of the body it consumed", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    await writer.put(putInput(stream("a", "bc"), { contentLength: 3 }));
    const object = writer.soleObject();
    assert.equal(object.observedBytes, 3);
    assert.equal(object.sha256, createHash("sha256").update("abc").digest("hex"));
    assert.equal((await stat(object.path)).size, 3);
    assert.equal(await readFile(object.path, "utf8"), "abc");
  });

  it("keeps the declared length apart from the bytes it stored", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    // A caller that declares four bytes and streams three.
    await writer.put(putInput(stream("abc"), { contentLength: 4 }));
    const object = writer.soleObject();
    assert.equal(object.declaredLength, 4);
    assert.equal(object.observedBytes, 3);
    assert.ok(!("contentLength" in object), "no field conflates declaration and measurement");
  });

  it("answers head with the PERSISTED length, never the caller's declaration", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    await writer.put(putInput(stream("abc"), { contentLength: 4 }));
    // What the provider holds, as R2's HeadObject would report it: 3, not 4.
    assert.equal((await writer.head(key(jobId))).contentLength, 3);
    assert.equal(writer.headLog()[0].contentLength, 3);
  });

  it("answers head with the same length when declaration and body agree", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    await writer.put(putInput(stream("abc"), { contentLength: 3 }));
    assert.deepEqual(await writer.head(key(jobId)), {
      objectKey: key(jobId),
      contentLength: 3,
      contentType: "video/mp4",
      contentDisposition: 'attachment; filename="x.mp4"',
    });
  });

  it("measures the stored object at HEAD time instead of replaying the put", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    await writer.put(putInput(stream("abc"), { contentLength: 3 }));
    const object = writer.soleObject();

    // The stored object changes after the put, and HEAD sees it: it is a
    // second observation, not the put-time counter.
    await writeFile(object.path, "ab");
    assert.equal((await writer.head(object.objectKey)).contentLength, 2);

    // A stored object that no longer exists is missing, not stale.
    await rm(object.path);
    assert.equal(await writer.head(object.objectKey), null);
  });

  it("enforces the real put schema at the provider boundary", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    await assert.rejects(() => writer.put(putInput(stream("a"), { objectKey: "not/a/key" })));
    await assert.rejects(() => writer.put(putInput(stream("a"), { contentType: "bad\ntype" })));
    await assert.rejects(() => writer.put(putInput(stream("a"), { contentLength: -1 })));
    await assert.rejects(() => writer.put(putInput("not a stream")));
    await assert.rejects(() => writer.put({ ...putInput(stream("a")), extra: 1 }));
    assert.equal(writer.putCount(), 0);
  });

  it("observes the caller BEFORE consuming a single byte", async () => {
    const seen = [];
    const writer = createLocalObjectStoreWriter({
      sinkDir: join(dir, randomUUID()),
      onPut: () => seen.push("observed"),
    });
    async function* watched() {
      seen.push("first-byte");
      yield Buffer.from("a");
    }
    await writer.put(putInput(watched(), { contentLength: 1 }));
    assert.deepEqual(seen, ["observed", "first-byte"]);
  });

  it("deletes exactly one key and has no list or wildcard form", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    await writer.put(putInput(stream("abc")));
    const object = writer.soleObject();

    assert.equal(typeof writer.list, "undefined");
    assert.equal(typeof writer.deletePrefix, "undefined");
    assert.equal(typeof writer.presign, "undefined");

    // An unknown key is a silent no-op, and touches nothing that exists.
    await writer.delete(key("0".repeat(32)));
    assert.notEqual(await writer.head(object.objectKey), null);

    await writer.delete(object.objectKey);
    assert.equal(await writer.head(object.objectKey), null);
    await assert.rejects(() => stat(object.path));

    // A malformed key is refused rather than interpreted.
    await assert.rejects(() => writer.delete("videofetch/../../etc/passwd"));
  });

  it("requires a task-owned sink directory", () => {
    assert.throws(() => createLocalObjectStoreWriter({ sinkDir: "" }), /task-owned sink directory/);
  });
});

// -- the REAL upload lifecycle against the local writer ----------------------

describe("split acceptance: real finalizeJobUpload against the local writer", () => {
  // The production lifecycle, the production SQLite store, and this harness's
  // writer. Nothing here re-implements the comparison: the question is whether
  // the REAL put -> head -> compare boundary refuses a provider that stored
  // fewer bytes than it was told to.
  let db;
  let store;
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "split06-lifecycle-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
  });
  afterEach(() => {
    db.close();
  });

  // The arrangement the production lifecycle suite uses: a real job, claimed,
  // then placed in `uploading`.
  function uploadingJob() {
    const created = store.createJob(
      { url: "https://example.com/video", formatId: "preset:best", principalId: "private-access-user" },
      randomUUID(),
    );
    store.claimNextQueuedJob();
    db.prepare("UPDATE worker_jobs SET status = 'uploading' WHERE job_id = ?").run(created.job.jobId);
    return created.job.jobId;
  }
  async function* bytes(text) {
    yield new TextEncoder().encode(text);
  }
  const finalize = (jobId, writer, body, fileSize) =>
    finalizeJobUpload({
      jobId,
      store,
      writer,
      body,
      fileSize,
      filename: "split-mp4-best.mp4",
      mime: "video/mp4",
      quality: "best",
      container: "mp4",
      randomSource: () => new Uint8Array(16).fill(0xab),
    });

  it("refuses a provider that stored fewer bytes than declared, and cleans up", async () => {
    const jobId = uploadingJob();
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });

    // Declared 4; streamed, stored and persisted 3.
    const result = await finalize(jobId, writer, bytes("abc"), 4);

    assert.deepEqual(result, { type: "storage_failure", code: "verification_failed", cleanup: "deleted" });
    const [put] = writer.putLog();
    assert.equal(put.declaredLength, 4);
    assert.equal(put.observedBytes, 3);
    // The one HEAD the REAL lifecycle issued reported the persisted size.
    assert.equal(writer.headLog().length, 1);
    assert.equal(writer.headLog()[0].contentLength, 3);
    // The lifecycle's own cleanup removed exactly that object.
    assert.deepEqual(writer.deleteLog(), [put.objectKey]);
    assert.equal(writer.soleObject(), null);
    assert.equal(await writer.head(put.objectKey), null);
    // And `ready` was never committed.
    const job = store.getJob(jobId);
    assert.equal(job.status, "uploading");
    assert.equal(job.objectKey, null);
  });

  it("commits ready when the stored bytes match the declaration", async () => {
    const jobId = uploadingJob();
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });

    const result = await finalize(jobId, writer, bytes("abc"), 3);

    assert.equal(result.type, "ready");
    assert.equal(writer.headLog()[0].contentLength, 3);
    assert.deepEqual(writer.deleteLog(), []);
    const job = store.getJob(jobId);
    assert.equal(job.status, "ready");
    assert.equal(job.fileSize, 3);
    assert.equal(job.objectKey, writer.soleObject().objectKey);
  });
});

// -- the container model ----------------------------------------------------

describe("split acceptance: container model", () => {
  it("runs the acceptance container with the network disabled", () => {
    const argv = acceptanceRunArgs({
      image: "videofetch-worker:split06-abc-local-test",
      family: "mp4",
      reportDir: "/var/tmp/split06",
      evidenceName: "e.json",
    });
    const joined = argv.join(" ");
    assert.match(joined, /--network none/);
    const i = argv.indexOf("--network");
    assert.equal(argv[i + 1], "none", "`--network` must name `none` and nothing else");
    assert.ok(!joined.includes("--network host"));
    assert.ok(!argv.includes("-p"), "no port is published");
    assert.ok(!joined.includes("--privileged"));
    assert.ok(!joined.includes("--cap-add"));
    assert.ok(!joined.includes("/var/run/docker.sock"));
  });

  it("mounts exactly one directory: where the run writes its own evidence", () => {
    const argv = acceptanceRunArgs({
      image: "i:t",
      family: "webm",
      reportDir: "/var/tmp/split06",
      evidenceName: "e.json",
    });
    const mounts = argv.filter((a, i) => argv[i - 1] === "-v");
    assert.deepEqual(mounts, ["/var/tmp/split06:/report"]);
    assert.match(argv.join(" "), /--evidence \/report\/e\.json/);
  });

  it("refuses a family, a relative report path or a path-shaped evidence name", () => {
    const ok = { image: "i:t", family: "mp4", reportDir: "/r", evidenceName: "e.json" };
    assert.throws(() => acceptanceRunArgs({ ...ok, family: "mkv" }), /mp4 or webm/);
    assert.throws(() => acceptanceRunArgs({ ...ok, reportDir: "relative" }), /absolute host path/);
    assert.throws(() => acceptanceRunArgs({ ...ok, evidenceName: "../escape" }), /plain basename/);
    assert.throws(() => acceptanceRunArgs({ ...ok, evidenceName: "a/b.json" }), /plain basename/);
  });

  it("tags the overlay unmistakably non-deployable", () => {
    const tag = overlayImageTag(HEAD);
    assert.equal(tag, "videofetch-worker:split06-b8f514e2916d-local-test");
    for (const forbidden of FORBIDDEN_OVERLAY_TAGS) {
      assert.ok(!tag.endsWith(`:${forbidden}`));
    }
    assert.throws(() => overlayImageTag("short"), /full candidate head SHA/);
  });

  it("keeps the broker out of the media container", () => {
    const dockerfile = overlayDockerfile("videofetch-worker:accepted");
    assert.match(dockerfile, /^FROM videofetch-worker:accepted$/m);
    assert.match(dockerfile, /rm -rf \/app\/src\/broker/);
    assert.match(dockerfile, /COPY --chown=node:node src \/app\/src/);
    assert.match(dockerfile, /USER node\s*$/);
    assert.match(dockerfile, /NOT A DEPLOYMENT ARTIFACT/);
    assert.throws(() => overlayDockerfile("no-tag"), /exact base image reference/);
  });

  it("builds the overlay from an explicit Dockerfile and context", () => {
    const argv = overlayBuildArgs({ image: "i:t", dockerfile: "/tmp/D", context: "/repo" });
    assert.deepEqual(argv, ["build", "-f", "/tmp/D", "-t", "i:t", "/repo"]);
    assert.ok(!argv.includes("--push"));
  });

  it("copies exactly the paths the provenance gate verifies", () => {
    const copies = overlayDockerfile("videofetch-worker:accepted")
      .split("\n")
      .filter((line) => line.startsWith("COPY "));
    assert.deepEqual([...OVERLAY_COPIED_PATHS], ["src", "deploy/acceptance/ytdlp-generic"]);
    assert.deepEqual(
      copies,
      OVERLAY_COPIED_PATHS.map((path) => `COPY --chown=node:node ${path} /app/${path}`),
    );
  });
});

// -- the evidence record ----------------------------------------------------

/** A `--max-filesize` observation that satisfies every -03 condition. */
const passingRefusal = (overrides = {}) => ({
  ceilingBytes: 53408,
  declaredContentLengthBytes: 106817,
  refusedHalf: "video",
  threw: true,
  acquisitionRuns: 1,
  maxFilesizeArgument: "53408",
  ytdlpExitCode: 0,
  ytdlpRefusalLineWasFinal: true,
  ytdlpStdoutBytes: 312,
  ytdlpStderrBytes: 0,
  finalFileExists: false,
  partFileExists: false,
  workDirEntries: [],
  canonicalErrorCode: MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  requiredCanonicalErrorCode: MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  ...overrides,
});

/**
 * A chunked refusal observation that satisfies every -04 condition. Shaped
 * like the MP4 family: a 17572-byte audio half, so an 8786-byte remainder and
 * 2928-byte chunks — three admitted, the fourth refused.
 */
const passingChunkedRefusal = (overrides = {}) => ({
  refusedHalf: "audio",
  chunkSizeSource: CHUNKED_REFUSAL_CHUNK_SIZE_SOURCE,
  httpChunkSizeBytes: 2928,
  httpFormatCount: 2,
  chunkedFormatCount: 2,
  paramsHttpChunkSizePassed: false,
  harnessArgumentAdded: CHUNKED_REFUSAL_HARNESS_ARGUMENT,
  manifestGetsDuringAcquisition: 0,
  threw: true,
  acquisitionRuns: 2,
  combinedLimitBytes: 115603,
  videoBytes: 106817,
  audioAllowanceBytes: 8786,
  maxFilesizeArguments: ["115603", "8786"],
  videoRangedGets: 37,
  videoRangesContiguous: true,
  videoArtifactMatchesFixture: true,
  audioRangedGets: 4,
  audioRangesContiguous: true,
  expectedEarlierChunks: 3,
  earlierChunksServed: 3,
  refusedRangeStartBytes: 8700,
  refusedRangeContentLengthBytes: 2928,
  declaredBytes: 11628,
  ytdlpExitCode: 0,
  ytdlpRefusalLineWasFinal: true,
  ytdlpStdoutBytes: 400,
  ytdlpStderrBytes: 0,
  finalFileExists: false,
  partIsRegularFile: true,
  partBytes: 8700,
  partMatchesFixturePrefix: true,
  workDirEntries: ["audio-source.m4a.part", "video-source.mp4"],
  expectedWorkDirEntries: ["audio-source.m4a.part", "video-source.mp4"],
  canonicalErrorCode: MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  requiredCanonicalErrorCode: MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  ...overrides,
});

describe("split acceptance: evidence record", () => {
  const minimal = (overrides = {}) => ({
    verdict: "PASS",
    family: "mp4",
    startedAt: "2026-09-12T00:00:00.000Z",
    finishedAt: "2026-09-12T00:00:10.000Z",
    source: {
      commit: HEAD,
      tree: TREE,
      contextClean: true,
      acceptedBaseSourceCommit: ACCEPTED_BASE_SOURCE,
      overlayRuntimeCompatibilityVerified: true,
    },
    image: {
      acceptedBaseImage: "videofetch-worker:accepted",
      acceptedBaseDigest: "sha256:abc",
      overlayImage: "videofetch-worker:split06-x-local-test",
      overlayImageId: "sha256:def",
    },
    network: { fixtureBind: "127.0.0.1", fixturePort: 1234 },
    toolchain: {
      node: "v22.23.2",
      ytdlpVersion: "2026.08.19",
      ytdlpArtifactPath: "/usr/local/lib/videofetch/yt-dlp",
      ffmpegPath: "/usr/bin/ffmpeg",
      ffmpegVersion: "5.1.9",
      ffprobePath: "/usr/bin/ffprobe",
      ffprobeVersion: "5.1.9",
      probeLocalMediaResult: "iso-bmff [video]",
    },
    fixtures: {},
    sourceDiscovery: {},
    analysis: {},
    plan: {},
    acquisition: {},
    lifecycle: {},
    processing: {},
    streamIdentity: {},
    upload: {},
    privacy: {},
    cleanup: {},
    negativeCases: {},
    maxFilesizeRefusal: passingRefusal(),
    maxFilesizeChunkedRefusal: passingChunkedRefusal(),
    ffmpegOverwriteRefusal: {},
    checks: [],
    ...overrides,
  });

  it("stamps its own schema and states the network mode", () => {
    const record = buildSplitEvidence(minimal());
    assert.equal(record.schema, SPLIT06_EVIDENCE_SCHEMA);
    assert.equal(record.schema, "split06-deterministic-full-path-04");
    assert.equal(record.network.mode, "none");
    assert.equal(record.network.publicHostsContacted, 0);
    assert.equal(record.network.dnsLookups, 0);
    assert.equal(record.image.deployable, false);
  });

  it("records the driver-verified provenance and what it compared", () => {
    const record = buildSplitEvidence(minimal());
    assert.deepEqual(record.source, {
      commit: HEAD,
      tree: TREE,
      contextClean: true,
      acceptedBaseSourceCommit: ACCEPTED_BASE_SOURCE,
      overlayRuntimeCompatibilityVerified: true,
      runtimeCompatibilityFilesCompared: [...OVERLAY_RUNTIME_COMPATIBILITY_FILES],
      verifiedBy: record.source.verifiedBy,
    });
    assert.match(record.source.verifiedBy, /before and after the overlay build/);
  });

  it("refuses to emit a record whose source was not verified", () => {
    const verified = minimal().source;
    for (const source of [
      undefined,
      { ...verified, contextClean: false },
      { ...verified, contextClean: "true" },
      { ...verified, overlayRuntimeCompatibilityVerified: undefined },
      { ...verified, commit: HEAD.slice(0, 12) },
      { ...verified, tree: TREE.toUpperCase() },
      { ...verified, acceptedBaseSourceCommit: null },
    ]) {
      assert.throws(
        () => buildSplitEvidence(minimal({ source })),
        /without driver-verified source provenance/,
      );
    }
  });

  it("refuses to emit a raw source identifier, and says where it found one", () => {
    for (const id of SPLIT06_FORBIDDEN_EVIDENCE_SUBSTRINGS) {
      assert.throws(
        () => buildSplitEvidence(minimal({ acquisition: { selector: `[format_id="${id}"]` } })),
        (err) =>
          /raw source identifier/.test(err.message) && /acquisition\.selector/.test(err.message),
      );
    }
  });

  it("refuses a forbidden field rather than quietly withholding it", () => {
    assert.throws(
      () => buildSplitEvidence(minimal({ processing: { stderr: "boom" } })),
      /containing a 'stderr' field/,
    );
    assert.throws(
      () => buildSplitEvidence(minimal({ acquisition: { argv: ["x"] } })),
      /containing a 'argv' field/,
    );
  });

  it("emits only the fields it names", () => {
    const record = buildSplitEvidence(minimal({ notAField: "x" }));
    assert.ok(!("notAField" in record));
    assert.deepEqual(Object.keys(record).sort(), [
      "acquisition",
      "analysis",
      "checks",
      "cleanup",
      "family",
      "ffmpegOverwriteRefusal",
      "finishedAt",
      "fixtures",
      "image",
      "lifecycle",
      "maxFilesizeChunkedRefusal",
      "maxFilesizeRefusal",
      "negativeCases",
      "network",
      "plan",
      "privacy",
      "processing",
      "schema",
      "source",
      "sourceDiscovery",
      "startedAt",
      "streamIdentity",
      "toolchain",
      "upload",
      "verdict",
    ]);
  });

  it("renders as reviewable JSON", () => {
    const text = renderSplitEvidence(buildSplitEvidence(minimal()));
    assert.equal(JSON.parse(text).schema, SPLIT06_EVIDENCE_SCHEMA);
    assert.ok(text.endsWith("\n"));
  });

  it("refuses a PASS whose --max-filesize refusal was not classified TOO_LARGE", () => {
    // Exactly the -02 observation: the pinned refusal reported PROCESSING_FAILED.
    assert.throws(
      () =>
        buildSplitEvidence(
          minimal({
            maxFilesizeRefusal: passingRefusal({ canonicalErrorCode: "PROCESSING_FAILED" }),
          }),
        ),
      /PASS .* max-filesize refusal failed: max-filesize\/classified-canonical-too-large/,
    );
    for (const overrides of [
      { threw: false },
      { finalFileExists: true },
      { partFileExists: true },
      { acquisitionRuns: 2 },
    ]) {
      assert.throws(
        () => buildSplitEvidence(minimal({ maxFilesizeRefusal: passingRefusal(overrides) })),
        /refusing to emit a PASS/,
      );
    }
    assert.throws(
      () => buildSplitEvidence(minimal({ maxFilesizeRefusal: undefined })),
      /refusing to emit a PASS/,
    );
  });

  it("a FAIL record still carries the refusal it observed", () => {
    const record = buildSplitEvidence(
      minimal({
        verdict: "FAIL",
        maxFilesizeRefusal: passingRefusal({ canonicalErrorCode: "PROCESSING_FAILED" }),
      }),
    );
    assert.equal(record.verdict, "FAIL");
    assert.equal(record.maxFilesizeRefusal.canonicalErrorCode, "PROCESSING_FAILED");
  });

  it("refuses a PASS whose CHUNKED --max-filesize refusal failed — a -03-shaped record included", () => {
    // A -03 record carried no chunked block: under -04 it can never be a PASS.
    assert.throws(
      () => buildSplitEvidence(minimal({ maxFilesizeChunkedRefusal: undefined })),
      /PASS .* chunked max-filesize refusal failed/,
    );
    // The shape's behaviour before this correction: its partial .part made the
    // Worker report PROCESSING_FAILED.
    assert.throws(
      () =>
        buildSplitEvidence(
          minimal({
            maxFilesizeChunkedRefusal: passingChunkedRefusal({ canonicalErrorCode: "PROCESSING_FAILED" }),
          }),
        ),
      /PASS .* chunked max-filesize refusal failed: max-filesize-chunked\/classified-canonical-too-large/,
    );
    for (const overrides of [
      { partBytes: 0 },
      { ytdlpExitCode: 1 },
      { earlierChunksServed: 0 },
      { paramsHttpChunkSizePassed: true },
    ]) {
      assert.throws(
        () => buildSplitEvidence(minimal({ maxFilesizeChunkedRefusal: passingChunkedRefusal(overrides) })),
        /refusing to emit a PASS/,
        JSON.stringify(overrides),
      );
    }
  });

  it("a FAIL record still carries the chunked refusal it observed", () => {
    const record = buildSplitEvidence(
      minimal({
        verdict: "FAIL",
        maxFilesizeChunkedRefusal: passingChunkedRefusal({ canonicalErrorCode: "PROCESSING_FAILED" }),
      }),
    );
    assert.equal(record.verdict, "FAIL");
    assert.equal(record.maxFilesizeChunkedRefusal.canonicalErrorCode, "PROCESSING_FAILED");
  });
});

// -- the -03 `--max-filesize` acceptance condition ---------------------------

describe("split acceptance: the -03 --max-filesize acceptance condition", () => {
  const failing = (overrides) =>
    evaluateMaxFilesizeRefusal(passingRefusal(overrides)).filter((c) => !c.ok);

  it("a refusal classified TOO_LARGE with nothing acquired satisfies every condition", () => {
    const checks = evaluateMaxFilesizeRefusal(passingRefusal());
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.deepEqual(
      checks.map((c) => c.name),
      [
        "max-filesize/declared-length-exceeds-allowance",
        "max-filesize/acquisition-was-refused",
        "max-filesize/one-yt-dlp-run-carrying-the-run-allowance",
        "max-filesize/left-no-final-file",
        "max-filesize/left-no-part-file",
        "max-filesize/classified-canonical-too-large",
      ],
    );
    assert.equal(MAX_FILESIZE_REFUSAL_REQUIRED_CODE, "TOO_LARGE");
  });

  it("the OLD behaviour no longer passes: PROCESSING_FAILED fails the condition", () => {
    const unmet = failing({ canonicalErrorCode: "PROCESSING_FAILED" });
    assert.deepEqual(
      unmet.map((c) => c.name),
      ["max-filesize/classified-canonical-too-large"],
    );
    assert.match(unmet[0].detail, /PROCESSING_FAILED/);
  });

  it("the yt-dlp exit code is recorded, never required", () => {
    for (const ytdlpExitCode of [0, 1, null]) {
      assert.deepEqual(failing({ ytdlpExitCode }), [], `exit ${ytdlpExitCode}`);
    }
  });

  it("every other requirement is enforced", () => {
    const cases = [
      [{ threw: false }, "max-filesize/acquisition-was-refused"],
      [{ finalFileExists: true }, "max-filesize/left-no-final-file"],
      [{ partFileExists: true }, "max-filesize/left-no-part-file"],
      // The audio half must never have started, and the one run that did must
      // carry this run's own allowance.
      [{ acquisitionRuns: 2 }, "max-filesize/one-yt-dlp-run-carrying-the-run-allowance"],
      [{ acquisitionRuns: 0 }, "max-filesize/one-yt-dlp-run-carrying-the-run-allowance"],
      [{ maxFilesizeArgument: "106817" }, "max-filesize/one-yt-dlp-run-carrying-the-run-allowance"],
      [{ maxFilesizeArgument: null }, "max-filesize/one-yt-dlp-run-carrying-the-run-allowance"],
      [{ declaredContentLengthBytes: 1 }, "max-filesize/declared-length-exceeds-allowance"],
      [{ ceilingBytes: 0 }, "max-filesize/declared-length-exceeds-allowance"],
    ];
    for (const [overrides, expected] of cases) {
      const names = failing(overrides).map((c) => c.name);
      assert.ok(names.includes(expected), `${JSON.stringify(overrides)} -> ${names.join(",")}`);
    }
  });

  it("an absent block satisfies nothing", () => {
    assert.equal(
      evaluateMaxFilesizeRefusal(undefined).every((c) => !c.ok),
      true,
    );
  });
});

// -- the -04 CHUNKED `--max-filesize` acceptance condition -------------------

describe("split acceptance: the -04 chunked --max-filesize acceptance condition", () => {
  const failing = (overrides) =>
    evaluateChunkedMaxFilesizeRefusal(passingChunkedRefusal(overrides)).filter((c) => !c.ok);

  it("a LATER-chunk refusal classified TOO_LARGE, its partial .part left, satisfies every condition", () => {
    const checks = evaluateChunkedMaxFilesizeRefusal(passingChunkedRefusal());
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.deepEqual(
      checks.map((c) => c.name),
      [
        "max-filesize-chunked/chunk-size-was-extractor-owned",
        "max-filesize-chunked/acquisition-used-the-loaded-info-document",
        "max-filesize-chunked/audio-run-carried-the-remainder",
        "max-filesize-chunked/video-half-was-acquired-in-chunks",
        "max-filesize-chunked/earlier-chunks-landed-before-a-later-one-was-refused",
        "max-filesize-chunked/declared-length-exceeds-allowance",
        "max-filesize-chunked/pinned-exit-0-with-the-refusal-as-final-line",
        "max-filesize-chunked/left-exactly-the-video-artifact-and-the-audio-part",
        "max-filesize-chunked/part-is-a-regular-file-within-the-allowance",
        "max-filesize-chunked/part-holds-exactly-the-earlier-chunks",
        "max-filesize-chunked/classified-canonical-too-large",
      ],
    );
    assert.equal(CHUNKED_REFUSAL_CHUNK_SIZE_SOURCE, "info_dict.downloader_options.http_chunk_size");
    assert.equal(CHUNKED_REFUSAL_HARNESS_ARGUMENT, "--load-info-json");
  });

  it("the shape's behaviour before this correction no longer passes: PROCESSING_FAILED fails the condition", () => {
    const unmet = failing({ canonicalErrorCode: "PROCESSING_FAILED" });
    assert.deepEqual(
      unmet.map((c) => c.name),
      ["max-filesize-chunked/classified-canonical-too-large"],
    );
    assert.match(unmet[0].detail, /PROCESSING_FAILED/);
  });

  it("every requirement is enforced", () => {
    const owned = "max-filesize-chunked/chunk-size-was-extractor-owned";
    const remainder = "max-filesize-chunked/audio-run-carried-the-remainder";
    const video = "max-filesize-chunked/video-half-was-acquired-in-chunks";
    const earlier = "max-filesize-chunked/earlier-chunks-landed-before-a-later-one-was-refused";
    const exit0 = "max-filesize-chunked/pinned-exit-0-with-the-refusal-as-final-line";
    const left = "max-filesize-chunked/left-exactly-the-video-artifact-and-the-audio-part";
    const part = "max-filesize-chunked/part-is-a-regular-file-within-the-allowance";
    const cases = [
      // The chunk size must arrive through the extractor-owned operand.
      [{ chunkSizeSource: "params.http_chunk_size" }, owned],
      [{ paramsHttpChunkSizePassed: true }, owned],
      [{ chunkedFormatCount: 1 }, owned],
      [{ httpFormatCount: 1, chunkedFormatCount: 1 }, owned],
      [{ harnessArgumentAdded: "--http-chunk-size" }, owned],
      [{ manifestGetsDuringAcquisition: 1 }, "max-filesize-chunked/acquisition-used-the-loaded-info-document"],
      // The audio half, and only the audio half, carries the remainder.
      [{ acquisitionRuns: 1 }, remainder],
      [{ maxFilesizeArguments: ["115603", "115603"] }, remainder],
      [{ audioAllowanceBytes: 8787 }, remainder],
      [{ videoRangedGets: 1 }, video],
      [{ videoRangesContiguous: false }, video],
      [{ videoArtifactMatchesFixture: false }, video],
      // A LATER chunk was refused, after exactly the predicted earlier ones.
      [{ earlierChunksServed: 0 }, earlier],
      [{ earlierChunksServed: 2 }, earlier],
      [{ audioRangesContiguous: false }, earlier],
      [{ refusedRangeStartBytes: 8699 }, earlier],
      [{ declaredBytes: 8786 }, "max-filesize-chunked/declared-length-exceeds-allowance"],
      [{ ytdlpExitCode: 1 }, exit0],
      [{ ytdlpRefusalLineWasFinal: false }, exit0],
      // Exactly the video artifact and the audio .part; nothing else.
      [{ finalFileExists: true }, left],
      [{ workDirEntries: ["video-source.mp4"] }, left],
      [
        { workDirEntries: ["audio-source.m4a.part", "audio-source.m4a.part-Frag1", "video-source.mp4"] },
        left,
      ],
      [{ partIsRegularFile: false }, part],
      [{ partBytes: 8787, refusedRangeStartBytes: 8787 }, part],
      [{ partMatchesFixturePrefix: false }, "max-filesize-chunked/part-holds-exactly-the-earlier-chunks"],
    ];
    for (const [overrides, expected] of cases) {
      const names = failing(overrides).map((c) => c.name);
      assert.ok(names.includes(expected), `${JSON.stringify(overrides)} -> ${names.join(",")}`);
    }
  });

  it("an absent block satisfies nothing", () => {
    assert.equal(
      evaluateChunkedMaxFilesizeRefusal(undefined).every((c) => !c.ok),
      true,
    );
  });
});

// -- the observers ----------------------------------------------------------

describe("split acceptance: observers", () => {
  it("records every Worker-owned spawn without changing it", async () => {
    const calls = [];
    const ledger = createRunnerLedger(async (opts) => {
      calls.push(opts);
      return { code: 0, stdout: "héllo", stderr: "" };
    });
    ledger.setPhase("acquisition");
    const opts = {
      command: "/usr/bin/python3",
      args: ["/usr/local/lib/videofetch/yt-dlp", "--format=b*[x]"],
      timeoutMs: 5,
    };
    const result = await ledger.runner(opts);

    assert.equal(result.code, 0);
    // Delegated verbatim: same object, same argv, same bounds.
    assert.equal(calls.length, 1);
    assert.equal(calls[0], opts);
    assert.equal(ledger.all().length, 1);
    assert.equal(ledger.inPhase("acquisition").length, 1);
    assert.equal(ledger.ytdlp().length, 1);
    assert.deepEqual(ledger.formatSelectors(), ["b*[x]"]);
  });

  it("records a failed spawn rather than losing it", async () => {
    const ledger = createRunnerLedger(async () => {
      throw new Error("spawn failed");
    });
    await assert.rejects(() => ledger.runner({ command: "x", args: [] }));
    assert.equal(ledger.all()[0].failed, true);
  });

  it("names the media tools that must not run during acquisition", () => {
    assert.ok(MEDIA_TOOL_BASENAMES.includes("ffmpeg"));
    assert.ok(MEDIA_TOOL_BASENAMES.includes("ffprobe"));
  });
});

// -- source provenance: the driver's gate ------------------------------------

describe("split acceptance: source provenance gate (driver)", () => {
  const CONTEXT = "/repo";
  const CAND_HEAD = "c".repeat(40);
  const CAND_TREE = "d".repeat(40);
  const OTHER_SHA = "1234567890abcdef1234567890abcdef12345678";
  const BASE_IMAGE = `videofetch-worker:${ACCEPTED_BASE_SOURCE}`;
  const BASE_DIGEST = "sha256:c3995e18dd3c51d6ddb186e3a3186360d24a2053439e067b71c7dec029f878fa";
  const OVERLAY_ID = `sha256:${"e".repeat(64)}`;

  const blobFor = (path, salt = "") => createHash("sha1").update(`${salt}${path}`).digest("hex");
  const sameBlobs = () =>
    Object.fromEntries(OVERLAY_RUNTIME_COMPATIBILITY_FILES.map((path) => [path, blobFor(path)]));

  /** A fake repository whose defaults pass every gate. */
  function repoState(overrides = {}) {
    return {
      head: CAND_HEAD,
      tree: CAND_TREE,
      status: "",
      untrackedInCopied: "",
      lsFiles: "H src/worker/a.ts\nH deploy/acceptance/ytdlp-generic/split-full-path.mjs\n",
      baseSourcePresent: true,
      blobsAtBase: sameBlobs(),
      blobsAtHead: sameBlobs(),
      afterBuild: null,
      ...overrides,
    };
  }

  /** The only process runner the driver gets: git and docker, both answered here. */
  function fakeProcesses(repo) {
    const calls = [];
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const fail = (code) => ({ code, stdout: "", stderr: "" });
    const git = (args) => {
      assert.deepEqual(args.slice(0, 3), ["--no-optional-locks", "-C", CONTEXT]);
      const [verb, ...rest] = args.slice(3);
      if (verb === "rev-parse") {
        const rev = rest.at(-1);
        if (rev === "HEAD") return ok(`${repo.head}\n`);
        if (rev === `${repo.head}^{tree}`) return ok(`${repo.tree}\n`);
        const at = rev.indexOf(":");
        const commit = rev.slice(0, at);
        const table =
          commit === ACCEPTED_BASE_SOURCE ? repo.blobsAtBase : commit === repo.head ? repo.blobsAtHead : {};
        const blob = table[rev.slice(at + 1)];
        return blob ? ok(`${blob}\n`) : fail(1);
      }
      if (verb === "status") return ok(rest.includes("--ignored=matching") ? repo.untrackedInCopied : repo.status);
      if (verb === "ls-files") return ok(repo.lsFiles);
      if (verb === "cat-file") return repo.baseSourcePresent ? ok() : fail(128);
      throw new Error(`unexpected git ${verb}`);
    };
    const docker = (args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return ok(`${args[2] === BASE_IMAGE ? BASE_DIGEST : OVERLAY_ID}\n`);
      }
      if (args[0] === "build") {
        if (repo.afterBuild) repo.afterBuild(repo);
        return ok();
      }
      if (args[0] === "run" || (args[0] === "image" && args[1] === "rm")) return ok();
      throw new Error(`unexpected docker ${args.join(" ")}`);
    };
    return {
      calls,
      dockerCalls: () => calls.filter((c) => c.command === "docker"),
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "git") return git(args);
        if (command === "docker") return docker(args);
        throw new Error(`unexpected command ${command}`);
      },
    };
  }

  let scratch;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "split06-driver-"));
  });
  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function drive(repo) {
    const processes = fakeProcesses(repo);
    const result = runSplitAcceptance(
      {
        baseImage: BASE_IMAGE,
        baseDigest: BASE_DIGEST,
        baseSource: ACCEPTED_BASE_SOURCE,
        head: CAND_HEAD,
        tree: CAND_TREE,
        context: CONTEXT,
        report: join(scratch, "report"),
        family: "mp4",
        keepImage: false,
        docker: "docker",
      },
      { run: processes.run, log: () => {}, scratchRoot: scratch, now: () => 1 },
    );
    return { processes, result };
  }

  it("P1: a correct, clean, runtime-compatible context passes and the container gets OBSERVATIONS", async () => {
    const { processes, result } = drive(repoState());
    const outcome = await result;
    assert.equal(outcome.code, 0);
    assert.deepEqual(
      outcome.provenance.runtimeCompatibilityFiles.map((f) => f.state),
      OVERLAY_RUNTIME_COMPATIBILITY_FILES.map(() => "SAME"),
    );

    // Every gate ran before the first Docker command...
    const firstDocker = processes.calls.findIndex((c) => c.command === "docker");
    const gitVerbsFirst = new Set(processes.calls.slice(0, firstDocker).map((c) => c.args[3]));
    for (const verb of ["rev-parse", "status", "ls-files", "cat-file"]) assert.ok(gitVerbsFirst.has(verb), verb);

    // ...and again after the build, before the container started.
    const at = (verb) => processes.calls.findIndex((c) => c.command === "docker" && c.args[0] === verb);
    assert.ok(
      processes.calls.slice(at("build"), at("run")).some((c) => c.command === "git" && c.args[3] === "status"),
      "the context is re-verified after the build",
    );

    const runArgv = processes.dockerCalls().find((c) => c.args[0] === "run").args;
    const valueOf = (flag) => runArgv[runArgv.indexOf(flag) + 1];
    assert.equal(valueOf("--source-commit"), CAND_HEAD);
    assert.equal(valueOf("--source-tree"), CAND_TREE);
    assert.equal(valueOf("--accepted-base-source"), ACCEPTED_BASE_SOURCE);
    assert.equal(valueOf("--base-digest"), BASE_DIGEST);
    assert.ok(runArgv.includes("--source-context-clean"));
    assert.ok(runArgv.includes("--overlay-runtime-compatible"));
    assert.deepEqual(processes.dockerCalls().at(-1).args.slice(0, 2), ["image", "rm"]);
  });

  const drift = (path) => ({ blobsAtHead: { ...sameBlobs(), [path]: blobFor(path, "drifted:") } });
  const refusals = [
    ["P2 wrong HEAD", { head: OTHER_SHA }, /HEAD is 1234567890abcdef.*not the expected c{40}/],
    ["P3 wrong tree", { tree: OTHER_SHA }, /has tree 1234567890abcdef.*not the expected d{40}/],
    ["P4 dirty tracked file", { status: " M src/worker/execution/job-executor.server.ts\n" }, /not clean/],
    ["P5 untracked file in the copied harness", { status: "?? deploy/acceptance/ytdlp-generic/stray.mjs\n" }, /not clean/],
    ["P5 ignored file inside copied source", { untrackedInCopied: "!! src/local.env\n" }, /does not track/],
    ["P5 hidden index entry under copied source", { lsFiles: "h src/worker/a.ts\n" }, /assume-unchanged or skip-worktree/],
    ["P6 accepted base source unavailable", { baseSourcePresent: false }, /not a commit in the build context/],
    ["P7 package.json drift", drift("package.json"), /no longer justified: package\.json differ/],
    ["P8 package-lock drift", drift("package-lock.json"), /no longer justified: package-lock\.json differ/],
    ["P9 Dockerfile.worker drift", drift("Dockerfile.worker"), /no longer justified: Dockerfile\.worker differ/],
    ["P10 yt-dlp runtime module drift", drift("src/worker/runtime/ytdlp-runtime.server.ts"), /ytdlp-runtime\.server\.ts differ/],
    ["P11 alias-loader drift", drift("scripts/register-ts-aliases.mjs"), /register-ts-aliases\.mjs differ/],
    ["P11 alias-hooks drift", drift("scripts/ts-alias-hooks.mjs"), /ts-alias-hooks\.mjs differ/],
  ];
  for (const [name, overrides, message] of refusals) {
    it(`${name}: refused before any Docker command`, async () => {
      const { processes, result } = drive(repoState(overrides));
      await assert.rejects(result, (error) => error instanceof ProvenanceError && message.test(error.message));
      assert.deepEqual(processes.dockerCalls(), [], "no docker inspect, build or run");
    });
  }

  it("treats a compatibility file absent from both commits as DIFFERENT", async () => {
    const missing = sameBlobs();
    delete missing["Dockerfile.worker"];
    const { processes, result } = drive(repoState({ blobsAtBase: missing, blobsAtHead: { ...missing } }));
    await assert.rejects(result, /no longer justified: Dockerfile\.worker differ/);
    assert.deepEqual(processes.dockerCalls(), []);
  });

  it("refuses a context that changed during the build: no container, overlay removed", async () => {
    const { processes, result } = drive(
      repoState({
        afterBuild: (repo) => {
          repo.status = "?? src/late.ts\n";
        },
      }),
    );
    await assert.rejects(result, /changed while the overlay was being built/);
    const verbs = processes.dockerCalls().map((c) => c.args.slice(0, 2).join(" "));
    assert.ok(verbs.some((v) => v.startsWith("build")));
    assert.ok(!verbs.some((v) => v.startsWith("run")), "the acceptance container never started");
    assert.equal(verbs.at(-1), "image rm");
  });

  it("requires full lowercase 40-hex --head, --tree and --base-source", () => {
    const argv = [
      "--base-image", BASE_IMAGE, "--base-digest", BASE_DIGEST, "--base-source", ACCEPTED_BASE_SOURCE,
      "--head", CAND_HEAD, "--tree", CAND_TREE, "--context", CONTEXT, "--report", "/var/tmp/r",
    ];
    assert.equal(parseDriverArgv(argv).tree, CAND_TREE);
    const without = (flag) => argv.filter((a, i) => a !== flag && argv[i - 1] !== flag);
    const replacing = (flag, value) => argv.map((a, i) => (argv[i - 1] === flag ? value : a));
    assert.throws(() => parseDriverArgv(without("--tree")), /--tree is required/);
    assert.throws(() => parseDriverArgv(without("--base-source")), /--base-source is required/);
    assert.throws(() => parseDriverArgv(replacing("--head", CAND_HEAD.slice(0, 12))), /--head must be a full lowercase 40-hex SHA/);
    assert.throws(() => parseDriverArgv(replacing("--tree", CAND_TREE.toUpperCase())), /--tree must be a full/);
    assert.throws(() => parseDriverArgv(replacing("--base-source", "e4fa646")), /--base-source must be a full/);
  });
});

// -- source provenance: against REAL Git -------------------------------------

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

describe(
  "split acceptance: source provenance gate against real Git",
  { skip: gitAvailable ? false : "git is not installed" },
  () => {
    // A throwaway repository, isolated from every user and system Git setting,
    // so what is proven is Git's own output and not this machine's config.
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "split06",
      GIT_AUTHOR_EMAIL: "split06@invalid",
      GIT_COMMITTER_NAME: "split06",
      GIT_COMMITTER_EMAIL: "split06@invalid",
    };
    let repo;
    let base;
    let head;
    let tree;
    const sh = (...args) =>
      execFileSync("git", ["-C", repo, ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const git = (args) =>
      new Promise((resolvePromise) => {
        execFile("git", ["--no-optional-locks", "-C", repo, ...args], { env }, (error, stdout) =>
          resolvePromise({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout }),
        );
      });
    const verify = (expectedHead = head, expectedTree = tree) =>
      verifyOverlayContextProvenance({ git, expectedHead, expectedTree, baseSource: base });
    const put = async (path, text) => {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    };

    before(async () => {
      repo = await mkdtemp(join(tmpdir(), "split06-git-"));
      sh("init", "-q");
      for (const path of OVERLAY_RUNTIME_COMPATIBILITY_FILES) await put(path, `accepted ${path}\n`);
      await put("src/app.ts", "export const v = 1;\n");
      await put("deploy/acceptance/ytdlp-generic/harness.mjs", "export {};\n");
      await put(".gitignore", "*.env\n");
      sh("add", "-A");
      sh("commit", "-q", "-m", "accepted source");
      base = sh("rev-parse", "HEAD");
      await put("src/app.ts", "export const v = 2;\n");
      sh("commit", "-q", "-am", "candidate");
      head = sh("rev-parse", "HEAD");
      tree = sh("rev-parse", "HEAD^{tree}");
    });
    after(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it("passes the clean candidate and reports every compatibility file SAME", async () => {
      const observed = await verify();
      assert.equal(observed.commit, head);
      assert.equal(observed.tree, tree);
      assert.equal(observed.acceptedBaseSourceCommit, base);
      assert.ok(observed.runtimeCompatibilityFiles.every((f) => f.state === "SAME"));
    });

    it("refuses a modified tracked file", async () => {
      await put("src/app.ts", "export const v = 333;\n");
      await assert.rejects(verify(), /not clean/);
      sh("checkout", "--", "src/app.ts");
      await verify();
    });

    it("refuses an untracked file inside the copied harness", async () => {
      await put("deploy/acceptance/ytdlp-generic/stray.mjs", "export {};\n");
      await assert.rejects(verify(), /not clean/);
      await rm(join(repo, "deploy/acceptance/ytdlp-generic/stray.mjs"));
      await verify();
    });

    it("refuses an IGNORED file inside copied source, which plain status does not list", async () => {
      await put("src/local.env", "X=1\n");
      assert.equal(sh("status", "--porcelain"), "", "precondition: plain status hides it");
      await assert.rejects(verify(), /does not track/);
      await rm(join(repo, "src/local.env"));
      await verify();
    });

    it("refuses a modification hidden behind assume-unchanged", async () => {
      sh("update-index", "--assume-unchanged", "src/app.ts");
      await put("src/app.ts", "export const v = 99999;\n");
      assert.equal(sh("status", "--porcelain"), "", "precondition: status hides it");
      await assert.rejects(verify(), /assume-unchanged or skip-worktree/);
      sh("update-index", "--no-assume-unchanged", "src/app.ts");
      sh("checkout", "--", "src/app.ts");
      await verify();
    });

    it("refuses a candidate whose package.json drifted from the accepted source", async () => {
      await put("package.json", "drifted\n");
      sh("commit", "-q", "-am", "drift");
      await assert.rejects(
        verify(sh("rev-parse", "HEAD"), sh("rev-parse", "HEAD^{tree}")),
        /no longer justified: package\.json differ/,
      );
      sh("reset", "-q", "--hard", head);
      await verify();
    });

    it("refuses a HEAD other than the expected one", async () => {
      await assert.rejects(verify(base, tree), /HEAD is .* not the expected/);
    });
  },
);
