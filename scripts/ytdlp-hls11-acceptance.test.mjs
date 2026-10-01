// Self-tests for the HLS-11 clear-HLS v2 release child's PURE modules
// (HLS-V2-ADAPTIVE-VOD-EXPANSION-001). The orchestrator itself imports product
// TypeScript and is exercised by the real release-image run; everything it
// decides with is pinned here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HLS11_CASES,
  HLS11_FIXTURE_HOST_MAPPING,
  HLS11_FIXTURE_HOSTNAME,
  classifyHls11FixturePath,
  createHls11PageUrlValidator,
  hls11Marker,
  hls11MediaPlaylistUri,
  hls11NearbyPageUrlAlternatives,
  hls11PageUrl,
  hls11RawFormatId,
} from "../deploy/acceptance/ytdlp-generic/lib/hls11-fixture-url.mjs";
import {
  HLS11_FIXTURE_SPEC,
  HLS11_INDEPENDENT_SEGMENTS_TAG,
  hls11ByteRangePlaylist,
  hls11DeclaredVersions,
  hls11EncryptedPlaylist,
  hls11FfmpegArgs,
  hls11Master,
  hls11SplitMaster,
  hls11ValuedIndependentSegmentsPlaylist,
  hls11VersionPlaylist,
  hls11WithoutIndependentSegments,
  topLevelBoxTypes,
} from "../deploy/acceptance/ytdlp-generic/fixtures/hls11-media.mjs";
import {
  analysisDocumentFacts,
  classifyHlsWorkspaceEntry,
  describeHlsSpawn,
} from "../deploy/acceptance/ytdlp-generic/lib/hls11-observers.mjs";
import {
  HLS11_FORBIDDEN_EVIDENCE_SUBSTRINGS,
  HLS11_GRAMMAR_CHECKS,
  HLS11_MANDATORY_CHECKS,
  HLS11_NON_CLAIMS,
  HLS11_POSITIVE_CASES,
  HLS11_RELEASE_EVIDENCE_SCHEMA,
  buildHls11ReleaseEvidence,
  validateHls11ReleaseChildRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/hls11-evidence.mjs";
import {
  HLS_V2_ADMITTED_KINDS,
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

const SOURCE = "7f1ecdaae583c4c7dc1e65c32f0416bab95d5d13";
const TREE = "dd3c4f3d7b76bb1f01a3416f9b9e78945e9ed659";
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const TAG = `videofetch-worker:split07-${SOURCE.slice(0, 12)}-local-test`;

// ── Addressing ─────────────────────────────────────────────────────────────

describe("HLS-11 fixture addressing", () => {
  it("uses one reserved hostname, disjoint from HLS-08's, mapped to loopback", () => {
    assert.equal(HLS11_FIXTURE_HOSTNAME, "hls11-fixture.example.invalid");
    assert.equal(HLS11_FIXTURE_HOST_MAPPING, "hls11-fixture.example.invalid:127.0.0.1");
    assert.ok(HLS11_FIXTURE_HOSTNAME.endsWith(".invalid"));
  });

  it("classifies every closed route of every case, and nothing else", () => {
    for (const caseName of HLS11_CASES) {
      assert.equal(classifyHls11FixturePath(`/hls11/${caseName}/watch.html`).kind, "page");
      assert.equal(classifyHls11FixturePath(`/hls11/${caseName}/master.m3u8`).kind, "master");
      assert.equal(classifyHls11FixturePath(`/hls11/${caseName}/${hls11MediaPlaylistUri(caseName)}`).kind, "media");
      assert.equal(classifyHls11FixturePath(`/hls11/${caseName}/init.mp4`).kind, "init");
      const fragment = classifyHls11FixturePath(`/hls11/${caseName}/seg-0.m4s`);
      assert.deepEqual([fragment.kind, fragment.ordinal, fragment.caseName], ["fragment", 1, caseName]);
      assert.equal(classifyHls11FixturePath(`/hls11/${caseName}/seg-3.ts`).ordinal, 4);
      assert.equal(classifyHls11FixturePath(`/hls11/${caseName}/key.bin`).kind, "key");
    }
    assert.equal(classifyHls11FixturePath("/hls11/split-master/audio-main.m3u8").kind, "media");
    for (const path of [
      "/hls11/v2-fmp4/media.m3u8",
      "/hls11/v2-fmp4/media.m3u8?sig=HLS11_PRIVATE_V1_TS",
      "/hls11/v2-fmp4/media.m3u8?sig=HLS11_PRIVATE_V2_FMP4&x=1",
      "/hls11/v2-fmp4/audio-main.m3u8",
      "/hls11/unknown/watch.html",
      "/hls11/v2-fmp4/init.mp4?x=1",
      "/hls11/v2-fmp4/sub/seg-0.m4s",
      "/hls08/watch.html",
      "/hls11/v2-fmp4/watch.html#x",
      "hls11/v2-fmp4/watch.html",
    ]) {
      assert.equal(classifyHls11FixturePath(path).kind, "unexpected", path);
    }
  });

  it("names a conspicuous private marker and raw format id per case", () => {
    assert.equal(hls11Marker("v2-fmp4"), "HLS11_PRIVATE_V2_FMP4");
    assert.equal(hls11RawFormatId("neg-video-only"), "hls-HLS11_RAW_NEG_VIDEO_ONLY");
    assert.throws(() => hls11Marker("nope"), /unknown HLS-11 case/);
  });

  it("admits exactly the case pages and refuses every nearby alternative", async () => {
    const validate = createHls11PageUrlValidator({ port: 40123, AppError: FakeAppError });
    assert.equal(validate.admitted.length, HLS11_CASES.length);
    for (const caseName of HLS11_CASES) {
      const url = hls11PageUrl(40123, caseName);
      assert.equal((await validate(url)).url, url);
    }
    for (const candidate of hls11NearbyPageUrlAlternatives(40123)) {
      await assert.rejects(validate(candidate), (error) => error.code === "INVALID_URL", candidate);
    }
  });
});

// ── Fixture recipes and playlists ──────────────────────────────────────────

describe("HLS-11 fixture recipes", () => {
  const value = (args, flag) => args[args.indexOf(flag) + 1];

  it("pins x264 to one thread, bit-exact muxing and FFmpeg's own HLS packaging", () => {
    for (const kind of ["ts", "fmp4", "fmp4-video"]) {
      const args = hls11FfmpegArgs(kind, "/out");
      assert.equal(value(args, "-threads"), "1", kind);
      assert.equal(value(args, "-fflags"), "+bitexact", kind);
      assert.equal(value(args, "-flags:v"), "+bitexact", kind);
      assert.equal(value(args, "-f"), "lavfi", kind);
      assert.equal(args[args.lastIndexOf("-f") + 1], "hls", kind);
      assert.equal(value(args, "-hls_playlist_type"), "vod", kind);
      assert.ok(value(args, "-i").includes(`size=${HLS11_FIXTURE_SPEC.width}x${HLS11_FIXTURE_SPEC.height}`));
    }
    assert.equal(value(hls11FfmpegArgs("ts", "/out"), "-hls_segment_type"), "mpegts");
    assert.equal(value(hls11FfmpegArgs("fmp4", "/out"), "-hls_segment_type"), "fmp4");
    assert.equal(value(hls11FfmpegArgs("fmp4", "/out"), "-hls_fmp4_init_filename"), "init.mp4");
    // The fMP4 renditions carry FFmpeg's own independent-segments declaration;
    // the MPEG-TS control stays the historical v1 subset.
    assert.equal(value(hls11FfmpegArgs("fmp4", "/out"), "-hls_flags"), "independent_segments");
    assert.equal(value(hls11FfmpegArgs("fmp4-video", "/out"), "-hls_flags"), "independent_segments");
    assert.ok(!hls11FfmpegArgs("ts", "/out").includes("-hls_flags"));
    assert.ok(hls11FfmpegArgs("fmp4-video", "/out").includes("-an"));
    assert.ok(!hls11FfmpegArgs("fmp4-video", "/out").includes("sine=frequency=440:sample_rate=48000:duration=4"));
    assert.throws(() => hls11FfmpegArgs("webm", "/out"), /unknown HLS-11 rendition/);
  });

  it("writes a single-variant master that claims video + audio and names the raw id", () => {
    const master = hls11Master("v2-fmp4");
    assert.ok(master.includes('CODECS="avc1.640028,mp4a.40.2"'));
    assert.ok(master.includes('NAME="HLS11_RAW_V2_FMP4"'));
    assert.ok(master.includes("RESOLUTION=1920x1080"));
    assert.ok(master.includes("media.m3u8?sig=HLS11_PRIVATE_V2_FMP4"));
    assert.ok(!master.includes("EXT-X-MEDIA"));
  });

  it("writes the split master with a grouped 1080p variant, a default + alternate audio, and an ungrouped control", () => {
    const master = hls11SplitMaster();
    assert.ok(master.includes('GROUP-ID="aud",NAME="Main",LANGUAGE="en",DEFAULT=YES'));
    assert.ok(master.includes('GROUP-ID="aud",NAME="Alt",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO'));
    assert.ok(master.includes('RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"'));
    assert.ok(master.includes('RESOLUTION=1280x720,CODECS="avc1.64001f"\n'));
  });

  it("derives the byte-range and encrypted negatives from the real fMP4 playlist", () => {
    const fmp4 = [
      "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1", "#EXT-X-PLAYLIST-TYPE:VOD",
      '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:1.000000,", "seg-0.m4s", "#EXT-X-ENDLIST", "",
    ].join("\n");
    assert.ok(hls11ByteRangePlaylist(fmp4, 1336).includes('#EXT-X-MAP:URI="init.mp4",BYTERANGE="1336@0"'));
    const encrypted = hls11EncryptedPlaylist(fmp4).split("\n");
    assert.equal(encrypted[2], '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    assert.throws(() => hls11ByteRangePlaylist("#EXTM3U\n", 1), /no map line/);
  });

  it("derives the version and independent-segments negatives from the packager's exact fMP4 text", () => {
    // The pinned ffmpeg 5.1.9 hls muxer's output with -hls_flags independent_segments.
    const fmp4 = [
      "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD",
      HLS11_INDEPENDENT_SEGMENTS_TAG, '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:1.000000,", "seg-0.m4s", "#EXT-X-ENDLIST", "",
    ].join("\n");
    assert.equal(HLS11_INDEPENDENT_SEGMENTS_TAG, "#EXT-X-INDEPENDENT-SEGMENTS");
    assert.deepEqual(hls11DeclaredVersions(fmp4), ["7"]);
    assert.deepEqual(hls11DeclaredVersions(hls11VersionPlaylist(fmp4, 5)), ["5"]);
    assert.deepEqual(hls11DeclaredVersions(hls11VersionPlaylist(fmp4, 6)), ["6"]);
    const missing = hls11VersionPlaylist(fmp4, null);
    assert.deepEqual(hls11DeclaredVersions(missing), []);
    assert.equal(missing, fmp4.replace("#EXT-X-VERSION:7\n", ""), "only the version line is removed");
    const without = hls11WithoutIndependentSegments(fmp4);
    assert.equal(without, fmp4.replace(`${HLS11_INDEPENDENT_SEGMENTS_TAG}\n`, ""), "only the declaration is removed");
    const valued = hls11ValuedIndependentSegmentsPlaylist(fmp4).split("\n");
    assert.equal(valued[5], `${HLS11_INDEPENDENT_SEGMENTS_TAG}:YES`);
    assert.throws(() => hls11VersionPlaylist(missing, 5), /no single version line/);
    assert.throws(() => hls11WithoutIndependentSegments(without), /no single independent-segments line/);
    assert.throws(() => hls11ValuedIndependentSegmentsPlaylist(without), /no independent-segments line/);
  });

  it("reads ISO-BMFF top-level boxes strictly", () => {
    const box = (type, size) => {
      const b = Buffer.alloc(size);
      b.writeUInt32BE(size, 0);
      b.write(type, 4, "latin1");
      return b;
    };
    assert.deepEqual(topLevelBoxTypes(Buffer.concat([box("ftyp", 16), box("moov", 8)])), ["ftyp", "moov"]);
    assert.throws(() => topLevelBoxTypes(Buffer.concat([box("ftyp", 16), Buffer.alloc(4)])), /truncated/);
    const lying = box("moof", 8);
    lying.writeUInt32BE(64, 0);
    assert.throws(() => topLevelBoxTypes(lying), /malformed box length/);
  });
});

// ── Observers ──────────────────────────────────────────────────────────────

describe("HLS-11 observers", () => {
  it("reduces a product media spawn to its tool, input, demuxer and copy posture", () => {
    const ts = describeHlsSpawn("/usr/bin/ffmpeg", [
      "-n", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mpegts", "-i", "/tmp/videofetch/jobs/x/hls-source.ts",
      "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "copy", "-f", "mp4", "/tmp/videofetch/jobs/x/hls-output.mp4.part",
    ]);
    assert.deepEqual(
      { tool: ts.tool, role: ts.role, input: ts.input, demuxer: ts.demuxer, streamCopy: ts.streamCopy, refusesOverwrite: ts.refusesOverwrite },
      { tool: "ffmpeg", role: "media", input: "hls-source.ts", demuxer: "mpegts", streamCopy: true, refusesOverwrite: true },
    );
    const probe = describeHlsSpawn("/usr/bin/ffprobe", ["-v", "error", "-f", "mov", "-i", "/w/hls-source.fmp4"]);
    assert.deepEqual([probe.tool, probe.input, probe.demuxer], ["ffprobe", "hls-source.fmp4", "mov"]);
    assert.equal(describeHlsSpawn("/usr/bin/ffprobe", ["-f", "mov", "-i", "/w/other.mp4"]).input, "<other>");
  });

  it("classifies the HLS workspace grammar and nothing else", () => {
    assert.equal(classifyHlsWorkspaceEntry("hls-source.fmp4.part"), "aggregate-partial");
    assert.equal(classifyHlsWorkspaceEntry("hls-source.ts"), "aggregate");
    assert.equal(classifyHlsWorkspaceEntry("hls-output.mp4.part"), "output-partial");
    assert.equal(classifyHlsWorkspaceEntry("hls-output.mp4"), "output");
    assert.equal(classifyHlsWorkspaceEntry("seg-0.m4s"), "unexpected");
  });

  it("reads a pinned -J split-master document as unpairable, without keeping the document", () => {
    // Key sets copied from the pinned yt-dlp 2026.08.19 output for this exact
    // master shape (HLS-V2 §8 investigation); URLs replaced by placeholders.
    const common = ["ext", "format", "format_id", "format_index", "has_drm", "http_headers", "manifest_url", "preference", "protocol", "quality", "resolution", "tbr", "url", "vbr", "abr", "aspect_ratio", "audio_ext", "video_ext"];
    const audio = (name, sourcePreference) => ({
      ...Object.fromEntries(common.map((k) => [k, null])),
      protocol: "m3u8_native", vcodec: "none", language: "en", format_note: name, source_preference: sourcePreference,
    });
    const video = (height, width) => ({
      ...Object.fromEntries(common.map((k) => [k, null])),
      protocol: "m3u8_native", vcodec: "avc1.640028", acodec: "none", height, width, fps: 30, dynamic_range: "SDR",
    });
    const doc = {
      extractor_key: "HTML5MediaEmbed",
      formats: [audio("Alt", -2), audio("Main", null), video(1080, 1920), video(720, 1280)],
    };
    const facts = analysisDocumentFacts(JSON.stringify(doc));
    assert.equal(facts.parsed, true);
    assert.equal(facts.videoRenditions, 2);
    assert.equal(facts.audioRenditions, 2);
    assert.equal(facts.audioRenditionsHaveNoAudioCodec, true);
    assert.deepEqual(facts.relationshipKeys, []);
    assert.equal(facts.groupedAndControlVariantsShareOneKeySet, true);
    assert.equal(facts.groupedAndControlVariantsBothAcodecNone, true);
    assert.ok(!JSON.stringify(facts).includes("m3u8_native"), "only closed facts survive");

    // Positive control: a document that DID expose a group id is noticed.
    const grouped = JSON.parse(JSON.stringify(doc));
    grouped.formats[2]._audio_group_id = "aud";
    grouped.formats[3].audio_group = "aud";
    assert.deepEqual(analysisDocumentFacts(JSON.stringify(grouped)).relationshipKeys, ["_audio_group_id", "audio_group"]);
    assert.equal(analysisDocumentFacts("{not json").parsed, false);
  });
});

// ── Evidence ───────────────────────────────────────────────────────────────

describe("HLS-11 evidence", () => {
  const input = (overrides = {}) => ({
    verdict: "PASS",
    startedAt: "2026-09-30T00:00:00.000Z",
    finishedAt: "2026-09-30T00:00:47.000Z",
    source: { commit: SOURCE, tree: TREE, contextClean: true },
    image: { candidateTag: TAG, imageId: IMAGE_ID, runSubject: IMAGE_ID },
    network: { observedInterfaceNames: ["lo"] },
    toolchain: {}, invariants: {}, fixture: {}, cases: {}, negativeCases: {}, splitMaster: {},
    checks: HLS11_MANDATORY_CHECKS.map((name) => ({ name, ok: true, detail: null })),
    ...overrides,
  });

  it("names its schema and requires both families, every negative and the split master", () => {
    assert.equal(HLS11_RELEASE_EVIDENCE_SCHEMA, "hls11-release-image-full-path-01");
    assert.deepEqual([...HLS11_POSITIVE_CASES], ["v1-ts", "v2-fmp4"]);
    assert.equal(HLS11_MANDATORY_CHECKS.length, 159);
    assert.equal(new Set(HLS11_MANDATORY_CHECKS).size, HLS11_MANDATORY_CHECKS.length);
    for (const name of [
      ...HLS11_GRAMMAR_CHECKS,
      "invariants/v2-grammar-admits-exactly-the-map-and-independent-segments",
      "v2-fmp4/acquisition/consumed-the-independent-segments-playlist",
      "v2-fmp4/acquisition/playlist-then-map-then-fragments-in-order",
      "v2-fmp4/ready/final-status-ready-with-matching-metadata",
      "neg-version-5/format-unavailable",
      "neg-version-5/refused-before-the-map-request",
      "neg-version-missing/refused-before-the-map-request",
      "neg-independent-segments-value/refused-before-the-map-request",
    ]) {
      assert.ok(HLS11_MANDATORY_CHECKS.includes(name), name);
    }
    // The fMP4-only consumption check is not asked of the MPEG-TS control.
    assert.ok(!HLS11_MANDATORY_CHECKS.includes("v1-ts/acquisition/consumed-the-independent-segments-playlist"));
    assert.deepEqual(HLS11_MANDATORY_CHECKS.slice(0, 6), [...HLS09_RELEASE_IDENTITY_CHECKS]);
    assert.ok(HLS11_NON_CLAIMS[0].includes("separate HLS audio"));
  });

  it("emits a PASS only when every mandatory check is present once and passing", () => {
    assert.equal(buildHls11ReleaseEvidence(input()).verdict, "PASS");
    const missing = input();
    missing.checks = missing.checks.filter((c) => c.name !== "v2-fmp4/lifecycle/no-media-tool-while-downloading");
    assert.throws(() => buildHls11ReleaseEvidence(missing), /recorded 0 times/);
    const duplicated = input();
    duplicated.checks = [...duplicated.checks, { name: "v1-ts/output/exactly-two-streams", ok: true, detail: null }];
    assert.throws(() => buildHls11ReleaseEvidence(duplicated), /recorded 2 times/);
    const failed = input();
    failed.checks = failed.checks.map((c) => (c.name === "neg-budget/too-large" ? { ...c, ok: false } : c));
    assert.throws(() => buildHls11ReleaseEvidence(failed), /failed/);
    assert.equal(buildHls11ReleaseEvidence({ ...failed, verdict: "FAIL" }).verdict, "FAIL");
  });

  it("refuses to emit private fixture material or a forbidden key, anywhere", () => {
    for (const needle of HLS11_FORBIDDEN_EVIDENCE_SUBSTRINGS) {
      assert.throws(() => buildHls11ReleaseEvidence(input({ fixture: { note: `x${needle}y` } })), /private fixture material/, needle);
    }
    assert.throws(() => buildHls11ReleaseEvidence(input({ fixture: { argv: ["x"] } })), /containing a/);
    assert.throws(() => buildHls11ReleaseEvidence(input({ source: { commit: "abc", tree: TREE, contextClean: true } })), /parent-verified/);
  });

  it("lets the parent validate an exact PASS, and names every shortfall", () => {
    const expected = { sourceCommit: SOURCE, sourceTree: TREE, candidateTag: TAG, candidateImageId: IMAGE_ID };
    const record = JSON.parse(JSON.stringify(buildHls11ReleaseEvidence(input())));
    assert.deepEqual(validateHls11ReleaseChildRecord(record, expected), []);
    assert.ok(validateHls11ReleaseChildRecord({ ...record, verdict: "FAIL" }, expected).some((p) => /verdict/.test(p)));
    assert.ok(validateHls11ReleaseChildRecord({ ...record, network: { mode: "bridge" } }, expected).some((p) => /network/.test(p)));
    assert.ok(validateHls11ReleaseChildRecord({ ...record, image: { ...record.image, runSubject: TAG } }, expected).some((p) => /run image/.test(p)));
    assert.deepEqual(validateHls11ReleaseChildRecord(null, expected), ["the record is not an object"]);
  });
});

// ── The shared transport's HLS v2 admission ───────────────────────────────

describe("HLS-11 use of the shared safe-HTTP acceptance transport", () => {
  const base = {
    port: 40123,
    eventClock: createEventClock(),
    statusNow: () => "downloading",
    realRequest: () => ({ on() {} }),
  };
  const pinned = (address) => (_h, _o, cb) => cb(null, address, 4);
  const request = (path, hostname) => ({
    protocol: "http:", hostname, port: 40123, method: "GET", agent: false, family: 4,
    lookup: pinned("8.8.8.8"), path,
    headers: { Host: `${hostname}:40123`, "User-Agent": "VideoFetch/1.0", Accept: "video/*,audio/*,*/*;q=0.8" },
  });

  it("admits the initialization map only with the HLS v2 classifier and kinds", () => {
    assert.deepEqual([...HLS_V2_ADMITTED_KINDS], ["media", "init", "fragment"]);
    const v2 = createHlsSafeHttpTransport({
      ...base, hostname: HLS11_FIXTURE_HOSTNAME, classify: classifyHls11FixturePath, admittedKinds: HLS_V2_ADMITTED_KINDS,
    });
    v2.requestFactory(request("/hls11/v2-fmp4/init.mp4", HLS11_FIXTURE_HOSTNAME));
    v2.requestFactory(request("/hls11/v2-fmp4/seg-0.m4s", HLS11_FIXTURE_HOSTNAME));
    assert.deepEqual(v2.ledger().map((e) => [e.kind, e.ordinal]), [["init", null], ["fragment", 1]]);
    assert.throws(() => v2.requestFactory(request("/hls11/v2-fmp4/key.bin", HLS11_FIXTURE_HOSTNAME)), /route kind key/);
  });

  it("keeps HLS-08's defaults: its classifier and media + fragment only", () => {
    const v1 = createHlsSafeHttpTransport({ ...base });
    assert.throws(() => v1.requestFactory(request("/hls11/v2-fmp4/init.mp4", "hls-fixture.example.invalid")), /route kind unexpected/);
  });
});
