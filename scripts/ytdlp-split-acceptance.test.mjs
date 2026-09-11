// Self-tests for the SPLIT-06 deterministic split-stream acceptance harness.
//
// These prove the HARNESS, not the product. They spawn no container, no
// FFmpeg, no ffprobe and no yt-dlp, and they reach no network: everything here
// is either pure argv/document construction or a loopback HTTP fixture. The
// full-path acceptance itself is a separate, explicitly invoked run --
// `deploy/acceptance/ytdlp-generic/run-split-acceptance.mjs`.
//
// One runtime requirement: `lib/local-object-writer.mjs` imports the REAL
// `ObjectStorePutInputSchema` from TypeScript source, because conforming to the
// real interface is the whole point of that module. Node 22.18+ strips types
// without a flag, which is what this repository's Worker image runs.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFixtureService,
  LISTEN_ADDRESS,
  PHASE_10D_ROUTES,
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
  overlayBuildArgs,
  overlayDockerfile,
  overlayImageTag,
} from "../deploy/acceptance/ytdlp-generic/lib/split-container.mjs";
import {
  buildSplitEvidence,
  renderSplitEvidence,
  SPLIT06_EVIDENCE_SCHEMA,
  SPLIT06_FORBIDDEN_EVIDENCE_SUBSTRINGS,
} from "../deploy/acceptance/ytdlp-generic/lib/split-evidence.mjs";
import {
  createRunnerLedger,
  MEDIA_TOOL_BASENAMES,
} from "../deploy/acceptance/ytdlp-generic/lib/split-observers.mjs";

const HEAD = "b8f514e2916d1e323518f21fa1e272165ef3fdf4";

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

  it("answers head with what the CALLER declared, so verification is not tautological", async () => {
    const writer = createLocalObjectStoreWriter({ sinkDir: join(dir, randomUUID()) });
    // A caller that declares four bytes and streams three is a lifecycle bug;
    // the writer must report the DECLARATION so `finalizeJobUpload` can catch
    // the mismatch against its own expectation.
    await writer.put(putInput(stream("abc"), { contentLength: 4 }));
    const head = await writer.head(key(jobId));
    assert.equal(head.contentLength, 4);
    assert.equal(writer.soleObject().observedBytes, 3);
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
});

// -- the evidence record ----------------------------------------------------

describe("split acceptance: evidence record", () => {
  const minimal = (overrides = {}) => ({
    verdict: "PASS",
    family: "mp4",
    startedAt: "2026-09-12T00:00:00.000Z",
    finishedAt: "2026-09-12T00:00:10.000Z",
    source: { commit: HEAD, tree: "779d5a21" },
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
    maxFilesizeCharacterization: {},
    ffmpegOverwriteRefusal: {},
    checks: [],
    ...overrides,
  });

  it("stamps its own schema and states the network mode", () => {
    const record = buildSplitEvidence(minimal());
    assert.equal(record.schema, SPLIT06_EVIDENCE_SCHEMA);
    assert.equal(record.schema, "split06-deterministic-full-path-01");
    assert.equal(record.network.mode, "none");
    assert.equal(record.network.publicHostsContacted, 0);
    assert.equal(record.network.dnsLookups, 0);
    assert.equal(record.image.deployable, false);
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
      "maxFilesizeCharacterization",
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
});

// -- the observers ----------------------------------------------------------

describe("split acceptance: observers", () => {
  it("records every Worker-owned spawn without changing it", async () => {
    const calls = [];
    const ledger = createRunnerLedger(async (opts) => {
      calls.push(opts);
      return { code: 0, stdout: "", stderr: "" };
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
