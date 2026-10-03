// Self-tests for the HLS-12 separate-audio clear-HLS release child's PURE
// modules (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001). The orchestrator
// itself imports product TypeScript and is exercised by the real release-image
// run; everything it decides with is pinned here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  HLS12_CASES,
  HLS12_EXECUTION_NEGATIVE_CASES,
  HLS12_FIXTURE_HOST_MAPPING,
  HLS12_FIXTURE_HOSTNAME,
  HLS12_MARKER_ROLES,
  HLS12_MASTER_NEGATIVE_CASES,
  HLS12_POSITIVE_CASES,
  HLS12_SYNTHETIC_PUBLIC_ADDRESS,
  classifyHls12FixturePath,
  createHls12PageUrlValidator,
  hls12AltAudioPlaylistUri,
  hls12AudioPlaylistUri,
  hls12GroupId,
  hls12Language,
  hls12Marker,
  hls12MasterUri,
  hls12MovedMasterPath,
  hls12NearbyPageUrlAlternatives,
  hls12PageUrl,
  hls12RenditionName,
  hls12VideoPlaylistUri,
} from "../deploy/acceptance/ytdlp-generic/lib/hls12-fixture-url.mjs";
import { HLS11_FIXTURE_HOSTNAME } from "../deploy/acceptance/ytdlp-generic/lib/hls11-fixture-url.mjs";
import {
  HLS12_FIXTURE_SPEC,
  HLS12_MASTER_SHAPES,
  HLS12_RECIPES,
  hls12FfmpegArgs,
  hls12Master,
  hls12Page,
} from "../deploy/acceptance/ytdlp-generic/fixtures/hls12-media.mjs";
import { createHls12FixtureService } from "../deploy/acceptance/ytdlp-generic/fixtures/hls12-server.mjs";
import {
  classifyHls12WorkspaceEntry,
  describeHls12Spawn,
  hls12AnalysisDocumentFacts,
} from "../deploy/acceptance/ytdlp-generic/lib/hls12-observers.mjs";
import {
  HLS12_CASE_CHECKS,
  HLS12_DEADLINE_CHECKS,
  HLS12_EXECUTION_NEGATIVE_CHECKS,
  HLS12_FORBIDDEN_EVIDENCE_SUBSTRINGS,
  HLS12_HISTORICAL_SCHEMAS,
  HLS12_MANDATORY_CHECKS,
  HLS12_NON_CLAIMS,
  HLS12_RELEASE_EVIDENCE_SCHEMA,
  HLS12_SUBSTITUTIONS,
  buildHls12ReleaseEvidence,
  validateHls12ReleaseChildRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/hls12-evidence.mjs";
import {
  HLS12_DEADLINE_CONTROL,
  evaluateHls12SharedDeadline,
  hls12DeadlineControlProblems,
} from "../deploy/acceptance/ytdlp-generic/lib/hls12-deadline.mjs";
import {
  HLS_MASTER_PROOF_ADMITTED_KINDS,
  PRODUCT_ACCEPT,
  PRODUCT_USER_AGENT,
  createEventClock,
  createHlsSafeHttpTransport,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-safe-http-transport.mjs";
import { HLS09_RELEASE_IDENTITY_CHECKS } from "../deploy/acceptance/ytdlp-generic/lib/hls-release-evidence.mjs";

class FakeAppError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const SOURCE = "eb1c3d111d77250e5fa7253bfe3c79952a1b2342";
const TREE = "88e258f2af8bb841c976c18e787ff100b64af601";
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const TAG = `videofetch-worker:split07-${SOURCE.slice(0, 12)}-local-test`;
const route = (caseName, reference) => `/hls12/${caseName}/${reference}`;

// ── Addressing ─────────────────────────────────────────────────────────────

describe("HLS-12 fixture addressing", () => {
  it("uses one reserved hostname, disjoint from HLS-11's, mapped to loopback", () => {
    assert.equal(HLS12_FIXTURE_HOSTNAME, "hls12-fixture.example.invalid");
    assert.equal(HLS12_FIXTURE_HOST_MAPPING, "hls12-fixture.example.invalid:127.0.0.1");
    assert.notEqual(HLS12_FIXTURE_HOSTNAME, HLS11_FIXTURE_HOSTNAME);
    assert.ok(HLS12_FIXTURE_HOSTNAME.endsWith(".invalid"));
    assert.equal(HLS12_SYNTHETIC_PUBLIC_ADDRESS, "8.8.8.8");
  });

  it("partitions a closed case vocabulary: three positives, four master and six execution negatives", () => {
    assert.deepEqual([...HLS12_POSITIVE_CASES], ["pos-audio-late", "pos-video-late", "ctl-aligned"]);
    assert.deepEqual([...HLS12_MASTER_NEGATIVE_CASES], [
      "neg-ambiguous-group", "neg-no-audio-group", "neg-master-redirect", "neg-master-changed",
    ]);
    assert.deepEqual([...HLS12_EXECUTION_NEGATIVE_CASES], [
      "neg-audio-ts", "neg-video-muxed", "neg-audio-video", "neg-budget", "neg-audio-map-404", "neg-deadline",
    ]);
    assert.equal(HLS12_CASES.length, 13);
    assert.equal(new Set(HLS12_CASES).size, 13);
  });

  it("names a conspicuous sentinel in every private slot, per case and role", () => {
    assert.equal(hls12Marker("pos-audio-late", "MASTER"), "HLS12_PRIVATE_POS_AUDIO_LATE_MASTER");
    assert.equal(hls12Marker("neg-master-changed", "RESIGNED"), "HLS12_PRIVATE_NEG_MASTER_CHANGED_RESIGNED");
    assert.equal(hls12GroupId("ctl-aligned"), "HLS12_GROUP_CTL_ALIGNED");
    assert.equal(hls12RenditionName("ctl-aligned"), "HLS12_RAW_CTL_ALIGNED");
    assert.equal(hls12Language("ctl-aligned"), "HLS12LANG-CTL_ALIGNED");
    assert.deepEqual([...HLS12_MARKER_ROLES], ["MASTER", "VIDEO", "AUDIO", "ALT", "RESIGNED"]);
    assert.throws(() => hls12Marker("nope", "MASTER"), /unknown HLS-12 case/);
    assert.throws(() => hls12Marker("ctl-aligned", "OTHER"), /unknown HLS-12 marker role/);
  });

  it("classifies every closed route of every case, with the role as the ledger family", () => {
    for (const caseName of HLS12_CASES) {
      assert.equal(classifyHls12FixturePath(route(caseName, "watch.html")).kind, "page");
      const master = classifyHls12FixturePath(route(caseName, hls12MasterUri(caseName)));
      assert.deepEqual([master.kind, master.role, master.family, master.variant], ["master", null, null, caseName]);
      const video = classifyHls12FixturePath(route(caseName, hls12VideoPlaylistUri(caseName)));
      assert.deepEqual([video.kind, video.role, video.family], ["media", "video", "video"]);
      const audio = classifyHls12FixturePath(route(caseName, hls12AudioPlaylistUri(caseName)));
      assert.deepEqual([audio.kind, audio.role, audio.family], ["media", "audio", "audio"]);
      for (const init of ["init.mp4", "init_0.mp4", "init_1.mp4"]) {
        assert.deepEqual([classifyHls12FixturePath(route(caseName, `audio/${init}`)).kind, classifyHls12FixturePath(route(caseName, `audio/${init}`)).role], ["init", "audio"]);
      }
      const fragment = classifyHls12FixturePath(route(caseName, "video/seg-0.m4s"));
      assert.deepEqual([fragment.kind, fragment.role, fragment.ordinal, fragment.caseName], ["fragment", "video", 1, caseName]);
      assert.equal(classifyHls12FixturePath(route(caseName, "audio/seg-4.ts")).ordinal, 5);
    }
    assert.equal(classifyHls12FixturePath(hls12MovedMasterPath("neg-master-redirect")).kind, "master-moved");
    assert.equal(classifyHls12FixturePath(route("neg-ambiguous-group", hls12AltAudioPlaylistUri("neg-ambiguous-group"))).role, "audio-alt");
    assert.equal(
      classifyHls12FixturePath(route("neg-master-changed", hls12VideoPlaylistUri("neg-master-changed", "RESIGNED"))).kind,
      "media",
    );
    for (const path of [
      route("pos-audio-late", "master.m3u8"),
      route("pos-audio-late", "master.m3u8?sig=HLS12_PRIVATE_CTL_ALIGNED_MASTER"),
      route("pos-audio-late", `${hls12MasterUri("pos-audio-late")}&x=1`),
      route("pos-audio-late", "video/media.m3u8"),
      route("pos-audio-late", "video/media.m3u8?sig=HLS12_PRIVATE_POS_AUDIO_LATE_AUDIO"),
      route("pos-audio-late", hls12AltAudioPlaylistUri("pos-audio-late")),
      route("pos-audio-late", hls12VideoPlaylistUri("pos-audio-late", "RESIGNED")),
      route("pos-audio-late", "moved/master.m3u8"),
      route("pos-audio-late", "subtitles/media.m3u8?sig=x"),
      route("pos-audio-late", "video/init_2.mp4"),
      route("pos-audio-late", "video/seg-0.m4s?x=1"),
      route("pos-audio-late", "video/deep/seg-0.m4s"),
      route("pos-audio-late", "watch.html#x"),
      "/hls12/unknown/watch.html",
      "/hls11/v2-fmp4/watch.html",
      "hls12/pos-audio-late/watch.html",
    ]) {
      assert.equal(classifyHls12FixturePath(path).kind, "unexpected", path);
    }
  });

  it("admits exactly the case pages and refuses every nearby alternative", async () => {
    const validate = createHls12PageUrlValidator({ port: 40123, AppError: FakeAppError });
    assert.equal(validate.admitted.length, HLS12_CASES.length);
    for (const caseName of HLS12_CASES) {
      const url = hls12PageUrl(40123, caseName);
      assert.equal((await validate(url)).url, url);
    }
    for (const candidate of hls12NearbyPageUrlAlternatives(40123)) {
      await assert.rejects(validate(candidate), (error) => error.code === "INVALID_URL", candidate);
    }
  });
});

// ── Recipes and masters ────────────────────────────────────────────────────

describe("HLS-12 fixture recipes", () => {
  const value = (args, flag) => args[args.indexOf(flag) + 1];

  it("pins x264 to one thread, bit-exact muxing and FFmpeg's own fMP4 HLS packaging", () => {
    for (const recipe of Object.keys(HLS12_RECIPES)) {
      const args = hls12FfmpegArgs(recipe, "/out");
      assert.equal(value(args, "-fflags"), "+bitexact", recipe);
      assert.equal(args[args.lastIndexOf("-f") + 1], "hls", recipe);
      assert.equal(value(args, "-hls_playlist_type"), "vod", recipe);
      assert.equal(value(args, "-map_metadata"), "-1", recipe);
      if (args.includes("-c:v")) assert.equal(value(args, "-threads"), "1", recipe);
    }
    assert.equal(value(hls12FfmpegArgs("audio-ts", "/out"), "-hls_segment_type"), "mpegts");
    assert.ok(!hls12FfmpegArgs("audio-ts", "/out").includes("-hls_fmp4_init_filename"));
    for (const recipe of ["pair-audio-late", "pair-video-late", "aligned-video", "aligned-audio", "muxed-fmp4"]) {
      const args = hls12FfmpegArgs(recipe, "/out");
      assert.equal(value(args, "-hls_segment_type"), "fmp4", recipe);
      assert.equal(value(args, "-hls_flags"), "independent_segments", recipe);
      assert.equal(value(args, "-hls_fmp4_init_filename"), "init.mp4", recipe);
    }
    assert.throws(() => hls12FfmpegArgs("webm", "/out"), /unknown HLS-12 recipe/);
  });

  it("offsets ONLY the audio input of the one-packager pairs, in opposite directions", () => {
    for (const [recipe, offset, duration] of [["pair-audio-late", "0.5", "4"], ["pair-video-late", "-0.5", "4.5"]]) {
      const args = hls12FfmpegArgs(recipe, "/out");
      const inputs = args.flatMap((arg, i) => (arg === "-i" ? [i] : []));
      assert.equal(inputs.length, 2, recipe);
      const at = args.indexOf("-itsoffset");
      assert.ok(at > inputs[0] && at < inputs[1], `${recipe}: the offset precedes the audio input only`);
      assert.equal(args.filter((arg) => arg === "-itsoffset").length, 1, recipe);
      assert.equal(args[at + 1], offset, recipe);
      assert.ok(args[inputs[1] + 1].startsWith("sine="), recipe);
      assert.ok(args[inputs[1] + 1].endsWith(`duration=${duration}`), recipe);
      assert.equal(value(args, "-var_stream_map"), "v:0,agroup:aud a:0,agroup:aud", recipe);
      assert.equal(args.at(-1), "/out/v%v/media.m3u8", recipe);
    }
  });

  it("packages the control's halves separately, and each single rendition with exactly its own streams", () => {
    const video = hls12FfmpegArgs("aligned-video", "/out");
    assert.equal(value(video, "-bf"), "0", "no B-frames: the control video starts at exactly 0");
    assert.ok(video.includes("-an") && !video.includes("-itsoffset"));
    assert.equal(video.filter((arg) => arg === "-i").length, 1);
    const audio = hls12FfmpegArgs("aligned-audio", "/out");
    assert.ok(audio.includes("-vn") && !audio.includes("-c:v") && !audio.includes("-itsoffset"));
    assert.ok(audio[audio.indexOf("-i") + 1].startsWith("sine="));
    const muxed = hls12FfmpegArgs("muxed-fmp4", "/out");
    assert.deepEqual(muxed.flatMap((arg, i) => (arg === "-map" ? [muxed[i + 1]] : [])), ["0:v", "1:a"]);
    assert.ok(!muxed.includes("-var_stream_map"));
  });

  it("writes the page naming the case's SIGNED master", () => {
    const page = hls12Page("pos-video-late");
    assert.ok(page.includes(`<source src="${hls12MasterUri("pos-video-late")}" type="application/x-mpegURL">`));
    assert.ok(page.includes("HLS12_PRIVATE_POS_VIDEO_LATE_MASTER"));
  });

  it("writes each closed master shape inside the candidate's grammar, sentinels in every descriptive slot", () => {
    assert.deepEqual([...HLS12_MASTER_SHAPES], ["paired", "ambiguous", "no-audio-group", "resigned"]);
    const lines = (text) => text.split("\n");
    const paired = hls12Master("pos-audio-late", "paired");
    const tags = lines(paired).filter((line) => line.startsWith("#")).map((line) => line.split(":")[0]);
    assert.deepEqual(tags, ["#EXTM3U", "#EXT-X-VERSION", "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-MEDIA", "#EXT-X-STREAM-INF"]);
    const media = lines(paired).filter((line) => line.startsWith("#EXT-X-MEDIA:"));
    assert.equal(media.length, 1);
    for (const slot of [
      'GROUP-ID="HLS12_GROUP_POS_AUDIO_LATE"', 'NAME="HLS12_RAW_POS_AUDIO_LATE"', 'LANGUAGE="HLS12LANG-POS_AUDIO_LATE"',
      `URI="${hls12AudioPlaylistUri("pos-audio-late")}"`, "DEFAULT=YES", "AUTOSELECT=YES",
    ]) {
      assert.ok(media[0].includes(slot), slot);
    }
    const variant = lines(paired).find((line) => line.startsWith("#EXT-X-STREAM-INF:"));
    assert.ok(variant.includes(`RESOLUTION=${HLS12_FIXTURE_SPEC.width}x${HLS12_FIXTURE_SPEC.height}`));
    assert.ok(variant.includes('CODECS="avc1.640028,mp4a.40.2",AUDIO="HLS12_GROUP_POS_AUDIO_LATE"'));
    assert.ok(!variant.includes("NAME="), "a variant carries no NAME: the closed master grammar refuses it");
    assert.equal(lines(paired)[lines(paired).indexOf(variant) + 1], hls12VideoPlaylistUri("pos-audio-late"));

    const ambiguous = hls12Master("neg-ambiguous-group", "ambiguous");
    const members = lines(ambiguous).filter((line) => line.startsWith("#EXT-X-MEDIA:"));
    assert.equal(members.length, 2);
    assert.ok(members.every((line) => line.includes('GROUP-ID="HLS12_GROUP_NEG_AMBIGUOUS_GROUP"')));
    assert.ok(members[1].includes("DEFAULT=NO,AUTOSELECT=NO") && members[1].includes(hls12AltAudioPlaylistUri("neg-ambiguous-group")));

    const ungrouped = hls12Master("neg-no-audio-group", "no-audio-group");
    assert.equal(lines(ungrouped).filter((line) => line.startsWith("#EXT-X-MEDIA:")).length, 1, "the convenient row is there");
    const plain = lines(ungrouped).find((line) => line.startsWith("#EXT-X-STREAM-INF:"));
    assert.ok(plain.includes('CODECS="avc1.640028"') && !plain.includes("AUDIO="));

    const resigned = hls12Master("neg-master-changed", "resigned");
    assert.ok(resigned.includes(hls12VideoPlaylistUri("neg-master-changed", "RESIGNED")));
    assert.ok(!resigned.includes(hls12VideoPlaylistUri("neg-master-changed")));

    const moved = hls12Master("neg-master-redirect", "paired", { referenceBase: "/hls12/neg-master-redirect/" });
    assert.ok(moved.includes(`URI="/hls12/neg-master-redirect/${hls12AudioPlaylistUri("neg-master-redirect")}"`));
    assert.ok(moved.includes(`\n/hls12/neg-master-redirect/${hls12VideoPlaylistUri("neg-master-redirect")}\n`));
    assert.throws(() => hls12Master("ctl-aligned", "paired", { referenceBase: "relative/" }), /root-relative/);
    assert.throws(() => hls12Master("ctl-aligned", "muxed"), /unknown HLS-12 master shape/);
  });
});

// ── The fixture service ────────────────────────────────────────────────────

describe("HLS-12 fixture service", () => {
  const get = (port, path, ua) =>
    new Promise((resolvePromise, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1", port, path,
          headers: { host: `${HLS12_FIXTURE_HOSTNAME}:${port}`, "user-agent": ua, accept: PRODUCT_ACCEPT },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
    });

  it("answers the closed table, ledgers every request, and answers the PRODUCT differently only where told", async () => {
    const masterPath = route("neg-master-redirect", hls12MasterUri("neg-master-redirect"));
    const changedPath = route("neg-master-changed", hls12MasterUri("neg-master-changed"));
    const routes = new Map([
      [route("ctl-aligned", "watch.html"), { kind: "page", body: Buffer.from("page") }],
      [masterPath, { kind: "master", body: Buffer.from("ordinary"), product: { status: 302, location: hls12MovedMasterPath("neg-master-redirect") } }],
      [changedPath, { kind: "master", body: Buffer.from("ordinary"), product: { status: 200, body: Buffer.from("re-signed") } }],
      [route("ctl-aligned", "audio/init.mp4"), { kind: "init", body: Buffer.from("init") }],
    ]);
    const service = createHls12FixtureService({ routes, eventClock: createEventClock() });
    const { address, port } = await service.listen();
    try {
      assert.equal(address, "127.0.0.1");
      service.setPhase("probe");
      assert.equal((await get(port, masterPath, "yt-dlp")).body, "ordinary");
      const redirected = await get(port, masterPath, PRODUCT_USER_AGENT);
      assert.deepEqual([redirected.status, redirected.headers.location], [302, hls12MovedMasterPath("neg-master-redirect")]);
      assert.equal((await get(port, changedPath, PRODUCT_USER_AGENT)).body, "re-signed");
      assert.equal((await get(port, changedPath, "yt-dlp")).body, "ordinary");
      service.fail(route("ctl-aligned", "audio/init.mp4"), 404);
      assert.equal((await get(port, route("ctl-aligned", "audio/init.mp4"), PRODUCT_USER_AGENT)).status, 404);
      assert.equal((await get(port, "/hls12/ctl-aligned/other.bin", "yt-dlp")).status, 404);
      const ledger = service.requests("probe");
      assert.deepEqual(
        ledger.map((e) => [e.kind, e.userAgentClass, e.status, e.productAnswer]),
        [
          ["master", "other", 200, false],
          ["master", "product", 302, true],
          ["master", "product", 200, true],
          ["master", "other", 200, false],
          ["init", "product", 404, false],
          ["unexpected", "other", 404, false],
        ],
      );
      assert.equal(ledger[4].role, "audio");
      assert.ok(ledger.every((e) => e.hostHeaderIsFixture && e.acceptIsProduct && !e.hasCookie && !e.hasRange));
      assert.ok(!JSON.stringify(ledger).includes("HLS12_PRIVATE_"), "the ledger never records a URL");
    } finally {
      await service.close();
    }
  });

  it("refuses a Product-only answer that is neither a body nor a root-relative redirect", () => {
    const bad = (product) => new Map([["/hls12/ctl-aligned/watch.html", { kind: "page", body: Buffer.from("x"), product }]]);
    for (const product of [{ status: 301, location: "/x" }, { status: 302, location: "http://elsewhere/x" }, { status: 200, body: "text" }]) {
      assert.throws(() => createHls12FixtureService({ routes: bad(product), eventClock: createEventClock() }), /Product-only answer/);
    }
  });

  // ── Holds (neg-deadline, since -02) ──────────────────────────────────────
  const anchor = route("neg-deadline", "video/init.mp4");
  const late = route("neg-deadline", "video/seg-3.m4s");
  const map = route("neg-deadline", "audio/init.mp4");
  const holdRoutes = () => new Map([
    [anchor, { kind: "init", body: Buffer.from("video-map") }],
    [late, { kind: "fragment", body: Buffer.from("late-fragment") }],
    [map, { kind: "init", body: Buffer.from("audio-map") }],
    [route("neg-master-redirect", hls12MasterUri("neg-master-redirect")), {
      kind: "master", body: Buffer.from("m"), product: { status: 302, location: hls12MovedMasterPath("neg-master-redirect") },
    }],
  ]);

  it("answers a held route with its OWN bytes, only after its anchor first arrived plus the hold", async () => {
    const service = createHls12FixtureService({ routes: holdRoutes(), eventClock: createEventClock() });
    const { port } = await service.listen();
    try {
      service.hold(late, { anchorPath: anchor, releaseAfterMs: 150 });
      service.setPhase("acquisition");
      assert.equal((await get(port, anchor, PRODUCT_USER_AGENT)).body, "video-map");
      const answered = await get(port, late, PRODUCT_USER_AGENT);
      assert.deepEqual([answered.status, answered.body], [200, "late-fragment"], "late, never different");
      const [first, held] = service.requests("acquisition");
      assert.equal(first.held, false);
      assert.equal(held.held, true);
      assert.equal(held.abandonedMs, null);
      // A timer may fire a fraction of a millisecond early on the monotonic clock.
      assert.ok(held.releasedMs - first.arriveMs >= 149, `${held.releasedMs - first.arriveMs}`);
      assert.ok(held.finishMs >= held.releasedMs && first.finishMs >= first.arriveMs);
      assert.ok(!JSON.stringify(service.requests()).includes("init.mp4"), "the ledger never records a path");
    } finally {
      await service.close();
    }
  });

  it("records a held route the client abandoned, unanswered, and answers a hold without its anchor 500", async () => {
    const service = createHls12FixtureService({ routes: holdRoutes(), eventClock: createEventClock() });
    const { port } = await service.listen();
    try {
      service.hold(map, { anchorPath: anchor, releaseAfterMs: 60_000 });
      service.hold(late, { anchorPath: route("neg-deadline", "audio/init.mp4"), releaseAfterMs: 1 });
      await get(port, anchor, PRODUCT_USER_AGENT);
      await new Promise((resolvePromise) => {
        const req = http.get({
          host: "127.0.0.1", port, path: map,
          headers: { host: `${HLS12_FIXTURE_HOSTNAME}:${port}`, "user-agent": PRODUCT_USER_AGENT, accept: PRODUCT_ACCEPT },
        });
        req.on("error", () => {});
        setTimeout(() => {
          req.destroy();
          setTimeout(resolvePromise, 50);
        }, 40);
      });
      const abandoned = service.requests().find((e) => e.held && e.kind === "init" && e.role === "audio");
      assert.equal(abandoned.status, null);
      assert.equal(abandoned.releasedMs, null);
      assert.ok(abandoned.abandonedMs - abandoned.arriveMs >= 30, "abandoned by the client, not answered");
    } finally {
      await service.close();
    }
    // An anchor that never arrived: fail closed rather than invent a release time.
    const lonely = createHls12FixtureService({ routes: holdRoutes(), eventClock: createEventClock() });
    const bound = await lonely.listen();
    try {
      lonely.hold(late, { anchorPath: anchor, releaseAfterMs: 1 });
      assert.equal((await get(bound.port, late, PRODUCT_USER_AGENT)).status, 500);
      assert.equal(lonely.requests()[0].held, true);
    } finally {
      await lonely.close();
    }
  });

  it("holds only two different routes of the table, for a positive whole number of milliseconds, never a Product-only answer", () => {
    const service = createHls12FixtureService({ routes: holdRoutes(), eventClock: createEventClock() });
    assert.throws(() => service.hold("/hls12/neg-deadline/video/seg-9.m4s", { anchorPath: anchor, releaseAfterMs: 1 }), /two different routes/);
    assert.throws(() => service.hold(late, { anchorPath: late, releaseAfterMs: 1 }), /two different routes/);
    for (const releaseAfterMs of [0, -1, 1.5, "10", Number.NaN]) {
      assert.throws(() => service.hold(late, { anchorPath: anchor, releaseAfterMs }), /positive whole number/);
    }
    assert.throws(
      () => service.hold(route("neg-master-redirect", hls12MasterUri("neg-master-redirect")), { anchorPath: anchor, releaseAfterMs: 1 }),
      /never held/,
    );
  });
});

// ── The shared-deadline discriminator (since -02) ──────────────────────────

describe("HLS-12 shared-deadline control", () => {
  it("is 10 s of budget, the video half's last fragment at 6 s, the audio map at 13 s, 1.5 s of slack", () => {
    assert.deepEqual({ ...HLS12_DEADLINE_CONTROL }, { budgetMs: 10_000, videoHoldMs: 6_000, audioReleaseMs: 13_000, slackMs: 1_500 });
    assert.ok(Object.isFrozen(HLS12_DEADLINE_CONTROL));
    assert.deepEqual(hls12DeadlineControlProblems(), []);
  });

  it("refuses a control that could not tell one shared deadline from a fresh one per half", () => {
    const at = (overrides) => hls12DeadlineControlProblems({ ...HLS12_DEADLINE_CONTROL, ...overrides });
    assert.match(at({ videoHoldMs: 8_000 })[0], /could not complete inside the shared budget/);
    assert.match(at({ audioReleaseMs: 11_000 })[0], /answered before the shared deadline/);
    assert.match(at({ audioReleaseMs: 15_000 }).join(";"), /fresh per-half deadline could expire/);
    assert.match(at({ slackMs: 0 })[0], /positive integer/);
    assert.match(at({ budgetMs: 10_000.5 })[0], /positive integer/);
  });
});

describe("HLS-12 shared-deadline evaluation", () => {
  // Fixture-ledger rows as the service records them; times on one monotonic clock.
  const row = (kind, role, ordinal, fields) => ({
    kind, role, ordinal, status: 200, held: false, releasedMs: null, abandonedMs: null, ...fields,
  });
  const A = 50_000; // the video map's arrival: every time is relative to it
  const videoHalf = (lastReleasedAfter = 6_000) => [
    row("init", "video", null, { arriveMs: A, finishMs: A + 1 }),
    row("fragment", "video", 1, { arriveMs: A + 2, finishMs: A + 3 }),
    row("fragment", "video", 2, { arriveMs: A + 4, finishMs: A + 5 }),
    row("fragment", "video", 3, { arriveMs: A + 6, finishMs: A + 7 }),
    row("fragment", "video", 4, {
      arriveMs: A + 8, held: true, releasedMs: A + lastReleasedAfter, finishMs: A + lastReleasedAfter + 1,
    }),
  ];
  const abandonedMap = (abandonedAfter) =>
    row("init", "audio", null, { arriveMs: A + 6_008, status: null, held: true, finishMs: null, abandonedMs: A + abandonedAfter });
  const evaluate = (requests) => evaluateHls12SharedDeadline({ requests, videoFragments: 4 });

  it("passes ONE shared deadline: video done inside it, the audio map abandoned unanswered at it", () => {
    const result = evaluate([...videoHalf(), abandonedMap(10_007)]);
    assert.equal(result.videoConsumedTheSharedDeadline, true);
    assert.equal(result.audioDidNotReceiveAFreshDeadline, true);
    assert.deepEqual(result.observed, {
      videoMapRequests: 1,
      videoFragmentsAnswered: 4,
      videoHeldFragmentReleasedAfterMs: 6_000,
      videoCompletedAfterMs: 6_001,
      remainingForAudioMs: 3_999,
      audioRequests: 1,
      audioFragmentsRequested: 0,
      audioMapRequestedAfterMs: 6_008,
      audioMapAnswered: false,
      audioMapReleasedAfterMs: null,
      audioMapAbandonedAfterMs: 10_007,
      freshDeadlineEarliestAfterMs: 16_001,
    });
    assert.ok(!JSON.stringify(result).includes("init"), "times and counts only");
  });

  it("refuses a FRESH deadline per half: the audio map outlives its late answer and the audio fragments follow", () => {
    const answered = row("init", "audio", null, { arriveMs: A + 6_008, held: true, releasedMs: A + 13_000, finishMs: A + 13_001 });
    const fragments = [1, 2, 3, 4, 5].map((n) => row("fragment", "audio", n, { arriveMs: A + 13_001 + n, finishMs: A + 13_002 + n }));
    const result = evaluate([...videoHalf(), answered, ...fragments]);
    assert.equal(result.videoConsumedTheSharedDeadline, true, "the video half is identical either way");
    assert.equal(result.audioDidNotReceiveAFreshDeadline, false);
    assert.deepEqual(
      [result.observed.audioMapAnswered, result.observed.audioMapReleasedAfterMs, result.observed.audioFragmentsRequested],
      [true, 13_000, 5],
    );
    // A fresh deadline that never got its answer is still caught: it stops the map too late.
    assert.equal(evaluate([...videoHalf(), abandonedMap(16_001)]).audioDidNotReceiveAFreshDeadline, false);
  });

  it("refuses an audio half stopped well BEFORE the shared deadline, or a map asked for before the video finished", () => {
    assert.equal(evaluate([...videoHalf(), abandonedMap(7_000)]).audioDidNotReceiveAFreshDeadline, false);
    const early = { ...abandonedMap(10_000), arriveMs: A + 5_000 };
    assert.equal(evaluate([...videoHalf(), early]).audioDidNotReceiveAFreshDeadline, false);
    const two = [...videoHalf(), abandonedMap(10_000), { ...abandonedMap(10_001), arriveMs: A + 6_009 }];
    assert.equal(evaluate(two).audioDidNotReceiveAFreshDeadline, false);
  });

  it("refuses a video half that did not consume the budget, did not finish inside it, or is incomplete", () => {
    const fast = videoHalf(10);
    assert.equal(evaluate([...fast, abandonedMap(10_000)]).videoConsumedTheSharedDeadline, false);
    assert.equal(evaluate([...videoHalf(8_700), abandonedMap(10_000)]).videoConsumedTheSharedDeadline, false);
    const missing = videoHalf().filter((r) => r.ordinal !== 3);
    assert.equal(evaluate([...missing, abandonedMap(10_000)]).videoConsumedTheSharedDeadline, false);
    const refused = videoHalf().map((r) => (r.ordinal === 2 ? { ...r, status: 404 } : r));
    assert.equal(evaluate([...refused, abandonedMap(10_000)]).videoConsumedTheSharedDeadline, false);
    const unanchored = evaluate(videoHalf().slice(1));
    assert.equal(unanchored.videoConsumedTheSharedDeadline, false);
    assert.equal(unanchored.audioDidNotReceiveAFreshDeadline, false);
    assert.equal(unanchored.observed.videoCompletedAfterMs, null);
  });

  it("never depends on the exact millisecond: a hold released a fraction early still passes", () => {
    const result = evaluate([...videoHalf(5_999.6), abandonedMap(9_998.7)]);
    assert.equal(result.videoConsumedTheSharedDeadline, true);
    assert.equal(result.audioDidNotReceiveAFreshDeadline, true);
  });
});

// ── Observers ──────────────────────────────────────────────────────────────

describe("HLS-12 observers", () => {
  it("reduces the merge argv to its two halves, demuxers, output and closed sync tokens", () => {
    const merge = describeHls12Spawn("/usr/bin/ffmpeg", [
      "-n", "-nostdin", "-v", "error",
      "-isync", "1", "-protocol_whitelist", "file", "-f", "mov", "-i", "/tmp/videofetch/jobs/j/hls-video.fmp4",
      "-protocol_whitelist", "file", "-f", "mov", "-i", "/tmp/videofetch/jobs/j/hls-audio.fmp4",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy",
      "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4",
      "/tmp/videofetch/jobs/j/merged.mp4",
    ]);
    assert.deepEqual([merge.tool, merge.role], ["ffmpeg", "media"]);
    assert.deepEqual(merge.inputs, ["hls-video.fmp4", "hls-audio.fmp4"]);
    assert.deepEqual(merge.demuxers, ["mov", "mov"]);
    assert.equal(merge.output, "merged.mp4");
    assert.equal(merge.streamCopy, true);
    assert.equal(merge.refusesOverwrite, true);
    assert.deepEqual(merge.sync.input0, ["-isync", "1"]);
    assert.deepEqual(merge.sync.input1, []);
    assert.deepEqual(merge.sync.forbiddenFlags, []);
    const probe = describeHls12Spawn("/usr/bin/ffprobe", ["-v", "error", "-f", "mov", "-i", "/w/hls-audio.fmp4"]);
    assert.deepEqual([probe.tool, probe.input, probe.demuxer, probe.output], ["ffprobe", "hls-audio.fmp4", "mov", null]);
    assert.deepEqual(describeHls12Spawn("/usr/bin/ffprobe", ["-i", "/w/hls-source.fmp4"]).inputs, ["<other>"]);
  });

  it("classifies the separate-audio workspace grammar, and nothing else", () => {
    assert.equal(classifyHls12WorkspaceEntry("hls-video.fmp4"), "half");
    assert.equal(classifyHls12WorkspaceEntry("hls-audio.fmp4.part"), "half-partial");
    assert.equal(classifyHls12WorkspaceEntry("merged.mp4"), "output");
    for (const name of ["hls-source.fmp4", "hls-output.mp4", "merged.mp4.part", "x"]) {
      assert.equal(classifyHls12WorkspaceEntry(name), "unexpected", name);
    }
  });

  it("reduces a pinned-yt-dlp document to counts and booleans, never a URL", () => {
    const master = "http://hls12-fixture.example.invalid:1/hls12/ctl-aligned/master.m3u8?sig=HLS12_PRIVATE_CTL_ALIGNED_MASTER";
    const doc = (rows) => JSON.stringify({ extractor_key: "HTML5MediaEmbed", formats: rows });
    const video = { protocol: "m3u8_native", vcodec: "avc1.640028", acodec: "none", height: 1080, manifest_url: master };
    const audio = { protocol: "m3u8_native", vcodec: "none", manifest_url: master };
    const facts = hls12AnalysisDocumentFacts(doc([video, audio]), master);
    assert.deepEqual(
      [facts.videoOnlyRenditions, facts.audioOnlyRenditions, facts.muxedRenditions, facts.relationshipKeys, facts.everyRowNamesTheSubmittedMaster],
      [1, 1, 0, [], true],
    );
    assert.ok(!JSON.stringify(facts).includes("HLS12_PRIVATE_"));
    assert.equal(hls12AnalysisDocumentFacts(doc([video, { ...audio, manifest_url: `${master}x` }]), master).everyRowNamesTheSubmittedMaster, false);
    assert.deepEqual(hls12AnalysisDocumentFacts(doc([{ ...video, _audio_group: "x" }, audio]), master).relationshipKeys, ["_audio_group"]);
    assert.equal(hls12AnalysisDocumentFacts(doc([{ ...video, acodec: "mp4a.40.2" }]), master).muxedRenditions, 1);
    assert.equal(hls12AnalysisDocumentFacts("{nope", master).parsed, false);
  });
});

// ── The acceptance transport, for the master proof ─────────────────────────

describe("HLS-12 acceptance transport", () => {
  const port = 40123;
  const request = (path) => ({
    protocol: "http:", hostname: HLS12_FIXTURE_HOSTNAME, port, method: "GET", agent: false, family: 4,
    lookup: (_h, _o, cb) => cb(null, "8.8.8.8", 4), path,
    headers: { Host: `${HLS12_FIXTURE_HOSTNAME}:${port}`, "User-Agent": PRODUCT_USER_AGENT, Accept: PRODUCT_ACCEPT },
  });
  const transport = () => createHlsSafeHttpTransport({
    port, eventClock: createEventClock(), statusNow: () => "analyzing", realRequest: () => ({ on() {} }),
    hostname: HLS12_FIXTURE_HOSTNAME, classify: classifyHls12FixturePath, admittedKinds: HLS_MASTER_PROOF_ADMITTED_KINDS,
  });

  it("admits the Product's master proof and its media requests, labelled by role, and refuses the redirect target", () => {
    const t = transport();
    t.requestFactory(request(route("pos-audio-late", hls12MasterUri("pos-audio-late"))));
    t.requestFactory(request(route("pos-audio-late", hls12AudioPlaylistUri("pos-audio-late"))));
    t.requestFactory(request(route("pos-audio-late", "audio/init_1.mp4")));
    t.requestFactory(request(route("pos-audio-late", "video/seg-2.m4s")));
    assert.deepEqual(
      t.ledger().map((e) => [e.kind, e.family, e.ordinal, e.variant, e.statusAtRequest]),
      [
        ["master", null, null, "pos-audio-late", "analyzing"],
        ["media", "audio", null, "pos-audio-late", "analyzing"],
        ["init", "audio", null, "pos-audio-late", "analyzing"],
        ["fragment", "video", 3, "pos-audio-late", "analyzing"],
      ],
    );
    assert.throws(() => t.requestFactory(request(hls12MovedMasterPath("neg-master-redirect"))), /route kind master-moved/);
    assert.throws(() => t.requestFactory(request(route("pos-audio-late", "watch.html"))), /route kind page/);
    assert.equal(t.refusals().length, 2);
  });
});

// ── Evidence ───────────────────────────────────────────────────────────────

describe("HLS-12 evidence", () => {
  const input = (overrides = {}) => ({
    verdict: "PASS",
    startedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: "2026-10-02T00:00:54.000Z",
    source: { commit: SOURCE, tree: TREE, contextClean: true },
    image: { candidateTag: TAG, imageId: IMAGE_ID, runSubject: IMAGE_ID },
    network: { observedInterfaceNames: ["lo"] },
    toolchain: {}, invariants: {}, fixture: {}, timing: {}, cases: {}, masterNegatives: {}, executionNegatives: {},
    checks: HLS12_MANDATORY_CHECKS.map((name) => ({ name, ok: true, detail: null })),
    ...overrides,
  });

  it("names its schema and requires every positive, every negative and every timing measurement", () => {
    assert.equal(HLS12_RELEASE_EVIDENCE_SCHEMA, "hls12-release-image-separate-audio-02");
    assert.deepEqual([...HLS12_HISTORICAL_SCHEMAS], ["hls12-release-image-separate-audio-01"]);
    assert.equal(HLS12_CASE_CHECKS.length, 39);
    // -01's 206, plus the eight shared-deadline checks of -02.
    assert.equal(HLS12_DEADLINE_CHECKS.length, 8);
    assert.equal(HLS12_MANDATORY_CHECKS.length, 206 + HLS12_DEADLINE_CHECKS.length);
    assert.equal(new Set(HLS12_MANDATORY_CHECKS).size, HLS12_MANDATORY_CHECKS.length);
    assert.deepEqual(HLS12_MANDATORY_CHECKS.slice(0, 6), [...HLS09_RELEASE_IDENTITY_CHECKS]);
    for (const name of [
      "timing/audio-late-pair-is-discriminating",
      "timing/video-late-pair-is-discriminating",
      "timing/control-pair-is-exactly-zero-aligned",
      "timing/oracle-detects-per-input-zeroing",
      "pos-audio-late/timing/relative-offset-preserved-within-the-time-base-tolerance",
      "pos-video-late/processing/sync-reference-is-the-earlier-input",
      "ctl-aligned/output/identical-to-the-historical-merge",
      "ctl-aligned/lifecycle/master-proof-while-analyzing",
      "neg-master-redirect/product-got-a-redirect-and-followed-nothing",
      "neg-master-changed/product-master-names-only-a-re-signed-video-url",
      "neg-ambiguous-group/plan-refuses-preset-1080",
      "neg-budget/refused-only-because-the-halves-share-one-budget",
      "neg-audio-map-404/video-half-complete-then-no-audio-fragment",
      "privacy/no-private-material-in-process-output",
      "neg-deadline/timeout",
      "neg-deadline/no-upload-never-ready",
      "neg-deadline/workdir-removed",
      "neg-deadline/video-consumed-the-shared-deadline",
      "neg-deadline/audio-did-not-receive-a-fresh-deadline",
      "neg-deadline/never-processing-no-media-tool",
    ]) {
      assert.ok(HLS12_MANDATORY_CHECKS.includes(name), name);
    }
    for (const name of HLS12_DEADLINE_CHECKS) assert.ok(HLS12_EXECUTION_NEGATIVE_CHECKS.includes(name), name);
    for (const caseName of HLS12_POSITIVE_CASES) {
      assert.ok(HLS12_MANDATORY_CHECKS.includes(`${caseName}/acquisition/master-then-playlists-then-video-then-audio`), caseName);
    }
    assert.ok(HLS12_NON_CLAIMS[0].startsWith("ONE separate-audio family only"));
  });

  it("emits a PASS only when every mandatory check is present once and passing", () => {
    assert.equal(buildHls12ReleaseEvidence(input()).verdict, "PASS");
    const missing = input();
    missing.checks = missing.checks.filter((c) => c.name !== "pos-video-late/output/packet-payloads-identical");
    assert.throws(() => buildHls12ReleaseEvidence(missing), /recorded 0 times/);
    const duplicated = input();
    duplicated.checks = [...duplicated.checks, { name: "ctl-aligned/cleanup/job-workdir-removed", ok: true, detail: null }];
    assert.throws(() => buildHls12ReleaseEvidence(duplicated), /recorded 2 times/);
    const failed = input();
    failed.checks = failed.checks.map((c) => (c.name === "neg-audio-ts/format-unavailable" ? { ...c, ok: false } : c));
    assert.throws(() => buildHls12ReleaseEvidence(failed), /failed/);
    assert.equal(buildHls12ReleaseEvidence({ ...failed, verdict: "FAIL" }).verdict, "FAIL");
    assert.throws(() => buildHls12ReleaseEvidence(input({ verdict: "MAYBE" })), /PASS, FAIL or BLOCKED/);
    assert.throws(() => buildHls12ReleaseEvidence(input({ source: { commit: SOURCE, tree: TREE, contextClean: false } })), /source identity/);
  });

  it("refuses to emit any private fixture material or a forbidden key, anywhere", () => {
    for (const needle of [
      "HLS12_PRIVATE_POS_AUDIO_LATE_VIDEO", "HLS12_RAW_CTL_ALIGNED", "HLS12_GROUP_CTL_ALIGNED", "HLS12LANG-CTL_ALIGNED",
      "hls12-fixture.example.invalid", "/hls12/ctl-aligned/", "master.m3u8", "media.m3u8", "alt.m3u8", "init_0",
      "seg-3", ".m4s", "127.0.0.1", "http://x", "/tmp/videofetch/jobs",
    ]) {
      assert.ok(HLS12_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((forbidden) => needle.includes(forbidden)), needle);
      assert.throws(() => buildHls12ReleaseEvidence(input({ fixture: { note: needle } })), /private fixture material/, needle);
    }
    assert.throws(() => buildHls12ReleaseEvidence(input({ cases: { stderr: "x" } })), /'\$\.cases\.stderr' field/);
    const record = buildHls12ReleaseEvidence(input());
    assert.equal(record.image.deployable, false);
    assert.equal(record.network.mode, "none");
    assert.ok(record.substitutions.productOnlyAnswers.includes("redirect"));
  });

  it("states the shared-deadline control in every record, and what it does not prove", () => {
    const record = buildHls12ReleaseEvidence(input());
    assert.equal(record.substitutions.deadlineControl, HLS12_SUBSTITUTIONS.deadlineControl);
    for (const fact of ["config.downloadTimeoutMs", "10000 ms", "6000 ms", "13000 ms", "No Product code, clock or timer is replaced"]) {
      assert.ok(record.substitutions.deadlineControl.includes(fact), fact);
    }
    assert.ok(record.substitutions.byteBudgetControl.includes("config.maxFileSize"));
    assert.ok(record.nonClaims.some((claim) => claim.startsWith("the ONE shared acquisition deadline is proven at a narrowed 10 s")));
  });

  it("validates a parsed record against the parent's own observations", () => {
    const record = JSON.parse(JSON.stringify(buildHls12ReleaseEvidence(input())));
    const expected = { sourceCommit: SOURCE, sourceTree: TREE, candidateTag: TAG, candidateImageId: IMAGE_ID };
    assert.deepEqual(validateHls12ReleaseChildRecord(record, expected), []);
    assert.match(validateHls12ReleaseChildRecord({ ...record, schema: "hls12-release-image-separate-audio-00" }, expected)[0], /schema is/);
    assert.match(validateHls12ReleaseChildRecord({ ...record, schema: "hls12-release-image-separate-audio-03" }, expected)[0], /schema is/);
    assert.ok(validateHls12ReleaseChildRecord(record, { ...expected, candidateImageId: `sha256:${"d".repeat(64)}` }).length > 0);
    assert.ok(validateHls12ReleaseChildRecord({ ...record, checks: record.checks.slice(1) }, expected).some((p) => /absent/.test(p)));
    assert.deepEqual(validateHls12ReleaseChildRecord([], expected), ["the record is not an object"]);
  });
});
