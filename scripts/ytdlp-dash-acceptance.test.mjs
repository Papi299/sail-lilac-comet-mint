// DASH-01 — the segmented-DASH real-media release child's pure parts.
//
// Everything here runs without Docker, FFmpeg or yt-dlp: the fixture splitter
// and manifests, the closed route grammar, the loopback fixture service, the
// observers, the evidence gates and the orchestrator's argv. The real-media
// chain itself is proven by running `dash-full-path.mjs` inside the release
// candidate (SPLIT-07 `-05`); these tests pin the machinery that judges it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import {
  DASH_CASES,
  DASH_FIXTURE_SPEC,
  DASH_MANIFEST_ROUTE,
  DASH_PROGRESSIVE_AUDIO_ROUTE,
  DASH_SYNTHETIC_FORMAT_IDS,
  classifyDashRoute,
  dashFfmpegArgs,
  dashInitRoute,
  dashManifest,
  dashRouteTable,
  dashSegmentRoute,
  splitFragmentedMp4,
  topLevelBoxes,
} from "../deploy/acceptance/ytdlp-generic/fixtures/dash-media.mjs";
import { createDashFixtureService } from "../deploy/acceptance/ytdlp-generic/fixtures/dash-server.mjs";
import {
  classifyWorkspaceEntry,
  createYtdlpLedger,
  describeSpawn,
  downloaderIdentity,
  installSpawnObserver,
} from "../deploy/acceptance/ytdlp-generic/lib/dash-observers.mjs";
import {
  DASH01_CASES,
  DASH01_CASE_CHECKS,
  DASH01_MANDATORY_CHECKS,
  DASH01_RELEASE_EVIDENCE_SCHEMA,
  buildDashReleaseEvidence,
  validateDashReleaseChildRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/dash-evidence.mjs";
import { parseDashArgv as parseArgv } from "../deploy/acceptance/ytdlp-generic/lib/dash-argv.mjs";

const SOURCE = "c62b646378fb3ed6016b8f219d4126fd1e34ac91";
const TREE = "5c4c7a8dd7beac03ce8d80aa4e59e87758df1151";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const TAG = `videofetch-worker:split07-${SOURCE.slice(0, 12)}-local-test`;

/** One ISO-BMFF box: 32-bit size, 4-char type, payload. */
function box(type, payload = Buffer.alloc(4)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function fragmented(...types) {
  return Buffer.concat(types.map((type, i) => box(type, Buffer.from(`${type}-${i}`))));
}

// ── The fixture ────────────────────────────────────────────────────────────

describe("DASH-01 fixture: the fragmented-MP4 splitter", () => {
  it("cuts ftyp+moov into the init and every moof+mdat into one media segment, byte for byte", () => {
    const file = fragmented("ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat");
    const { init, segments, topLevelTypes } = splitFragmentedMp4(file);
    assert.deepEqual(topLevelTypes, ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat"]);
    assert.equal(segments.length, 3);
    assert.deepEqual(topLevelBoxes(init).map((b) => b.type), ["ftyp", "moov"]);
    for (const segment of segments) assert.deepEqual(topLevelBoxes(segment).map((b) => b.type), ["moof", "mdat"]);
    assert.ok(Buffer.concat([init, ...segments]).equals(file));
  });

  it("refuses every shape the manifest could not describe exactly", () => {
    for (const [label, file] of [
      ["an mfra trailer", fragmented("ftyp", "moov", "moof", "mdat", "mfra")],
      ["a moof without its mdat", fragmented("ftyp", "moov", "moof", "moof", "mdat")],
      ["a sidx before the fragments", fragmented("ftyp", "moov", "sidx", "moof", "mdat")],
      ["no moov", fragmented("ftyp", "moof", "mdat")],
      ["no fragments at all", fragmented("ftyp", "moov", "mdat")],
    ]) {
      assert.throws(() => splitFragmentedMp4(file), Error, label);
    }
    const truncated = fragmented("ftyp", "moov", "moof", "mdat").subarray(0, 30);
    assert.throws(() => topLevelBoxes(truncated), /bad box length|truncated/);
    const zero = Buffer.concat([fragmented("ftyp"), Buffer.from([0, 0, 0, 0, 0x6d, 0x6f, 0x6f, 0x76])]);
    assert.throws(() => topLevelBoxes(zero), /to-end-of-file/);
  });

  it("pins the determinism levers and the 1920x1080 geometry in the recipes", () => {
    const video = dashFfmpegArgs("video-fragmented", "/o/v.mp4");
    for (const lever of ["+bitexact", "-map_metadata", "-an"]) assert.ok(video.includes(lever), lever);
    assert.equal(video[video.indexOf("-threads") + 1], "1");
    assert.ok(video.includes("testsrc2=size=1920x1080:rate=24:duration=2"));
    assert.equal(video[video.indexOf("-movflags") + 1], "+empty_moov+default_base_moof+frag_keyframe+skip_trailer");
    assert.equal(video[video.indexOf("-g") + 1], String(DASH_FIXTURE_SPEC.video.gop));
    const audio = dashFfmpegArgs("audio-fragmented", "/o/a.mp4");
    assert.ok(audio.includes("-vn") && audio.includes("+empty_moov+default_base_moof+skip_trailer"));
    const progressive = dashFfmpegArgs("audio-progressive", "/o/p.m4a");
    assert.ok(progressive.includes("+faststart") && progressive.includes("ipod"));
    assert.throws(() => dashFfmpegArgs("video-muxed", "/o/x.mp4"), /unknown/);
  });
});

describe("DASH-01 fixture: manifests and the closed route grammar", () => {
  const counts = { video: 4, audio: 4 };

  it("describes segmented video + segmented audio as SegmentList renditions with relative references", () => {
    const mpd = dashManifest("dash-dash", { segmentCounts: counts });
    assert.match(mpd, /type="static"/);
    assert.equal((mpd.match(/<Period /g) ?? []).length, 1, "one Period");
    assert.equal((mpd.match(/<SegmentList /g) ?? []).length, 2);
    assert.equal((mpd.match(/<SegmentURL /g) ?? []).length, 8);
    assert.match(mpd, /width="1920" height="1080"/);
    assert.ok(mpd.includes(`id="${DASH_SYNTHETIC_FORMAT_IDS.video}"`));
    assert.ok(mpd.includes(`id="${DASH_SYNTHETIC_FORMAT_IDS.audio}"`));
    assert.ok(!mpd.includes("http"), "no absolute reference");
    assert.ok(!mpd.includes("<BaseURL>"));
  });

  it("describes segmented video + progressive audio with the audio as one BaseURL", () => {
    const mpd = dashManifest("dash-progressive", { segmentCounts: counts });
    assert.equal((mpd.match(/<SegmentList /g) ?? []).length, 1);
    assert.ok(mpd.includes(`<BaseURL>${DASH_PROGRESSIVE_AUDIO_ROUTE.slice(1)}</BaseURL>`));
    assert.ok(mpd.includes(`id="${DASH_SYNTHETIC_FORMAT_IDS.progressiveAudio}"`));
  });

  it("refuses a manifest for too few segments or an unknown case", () => {
    assert.throws(() => dashManifest("dash-dash", { segmentCounts: { video: 2, audio: 4 } }), /at least/);
    assert.throws(() => dashManifest("hls", { segmentCounts: counts }), /unknown DASH case/);
  });

  it("classifies exactly the declared routes, and nothing else", () => {
    assert.deepEqual(classifyDashRoute(DASH_MANIFEST_ROUTE["dash-dash"], { segmentCounts: counts }).kind, "manifest");
    assert.deepEqual(classifyDashRoute(dashInitRoute("video"), { segmentCounts: counts }), {
      kind: "init", role: "video", ordinal: 0, caseName: null,
    });
    assert.equal(classifyDashRoute(dashSegmentRoute("audio", 4), { segmentCounts: counts }).ordinal, 4);
    for (const path of [
      dashSegmentRoute("video", 5), "/dash01-video-0.m4s", "/dash01-video-1.m4s?x=1", "/../etc/passwd",
      "/dash01-dash-dash.mpd/", "/DASH01-video-1.m4s", "",
    ]) {
      assert.equal(classifyDashRoute(path, { segmentCounts: counts }).kind, "unknown", path);
    }
    assert.throws(() => dashSegmentRoute("video", 0));
    assert.throws(() => dashInitRoute("subtitles"));
  });

  it("keeps the case list the evidence module requires in step with the fixture's", () => {
    assert.deepEqual([...DASH01_CASES], [...DASH_CASES]);
  });
});

// ── The fixture service ────────────────────────────────────────────────────

function get(port, path, method = "GET") {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function fakeFixtures() {
  const seg = (tag, n) => Buffer.from(`${tag}-${n}-`.repeat(40));
  return {
    video: { init: Buffer.from("vinit"), segments: [1, 2, 3, 4].map((n) => seg("v", n)) },
    audio: { init: Buffer.from("ainit"), segments: [1, 2, 3].map((n) => seg("a", n)) },
    progressiveAudio: { bytes: Buffer.from("progressive-audio") },
  };
}

describe("DASH-01 fixture service", () => {
  it("serves only the closed table on loopback, and records kinds, never paths", async () => {
    const { table, segmentCounts } = dashRouteTable(fakeFixtures());
    const service = createDashFixtureService({ table, segmentCounts });
    const { address, port } = await service.listen();
    try {
      assert.equal(address, "127.0.0.1");
      service.setPhase("t");
      const init = await get(port, dashInitRoute("video"));
      assert.equal(init.status, 200);
      assert.equal(init.body.toString(), "vinit");
      assert.equal((await get(port, dashSegmentRoute("audio", 4))).status, 404, "audio has three segments");
      assert.equal((await get(port, "/etc/passwd")).status, 404);
      assert.equal((await get(port, dashInitRoute("video"), "POST")).status, 405);
      const ledger = service.requests("t");
      assert.deepEqual(ledger.map((r) => [r.kind, r.status]), [["init", 200], ["unknown", 404], ["unknown", 404], ["init", 405]]);
      assert.ok(!JSON.stringify(ledger).includes("/"), "no path in the ledger");
    } finally {
      await service.close();
    }
  });

  it("answers a failing route with its status, and a held route stops short when the client leaves", async () => {
    const { table, segmentCounts } = dashRouteTable(fakeFixtures());
    const service = createDashFixtureService({ table, segmentCounts });
    const { port } = await service.listen();
    try {
      service.setBehavior({ failing: { route: dashSegmentRoute("video", 2), status: 404 } });
      assert.equal((await get(port, dashSegmentRoute("video", 2))).status, 404);
      assert.equal((await get(port, dashSegmentRoute("video", 3))).status, 200);

      service.setBehavior({ hold: { route: dashSegmentRoute("video", 4), tailBytes: 8, holdMs: 30_000 } });
      service.setPhase("hold");
      await new Promise((resolvePromise) => {
        const req = request({ host: "127.0.0.1", port, path: dashSegmentRoute("video", 4) }, (res) => {
          res.once("data", () => {
            req.destroy();
            setTimeout(resolvePromise, 50);
          });
        });
        req.on("error", () => {});
        req.end();
      });
      const [held] = service.requests("hold");
      assert.equal(held.held, true);
      assert.equal(held.finished, false);
      assert.equal(held.clientClosedEarly, true);
      assert.ok(held.bytesWritten < held.declaredLength);
    } finally {
      await service.close();
    }
  });

  it("refuses behaviours outside the model", () => {
    const { table, segmentCounts } = dashRouteTable(fakeFixtures());
    const service = createDashFixtureService({ table, segmentCounts });
    assert.throws(() => service.setBehavior({ failing: { route: "/nope", status: 404 } }), /unknown route/);
    assert.throws(() => service.setBehavior({ failing: { route: dashInitRoute("video"), status: 200 } }), /error status/);
    assert.throws(() => service.setBehavior({ hold: { route: dashInitRoute("video"), tailBytes: 0, holdMs: 10 } }));
    assert.throws(() => service.setBehavior({ pace: { pauseMs: 5000 } }));
    assert.throws(() => createDashFixtureService({ table: new Map([["/x", { body: Buffer.from("x") }]]), segmentCounts }));
  });
});

// ── The observers ──────────────────────────────────────────────────────────

describe("DASH-01 observers", () => {
  const YTDLP = "/usr/local/lib/videofetch/yt-dlp";

  it("reduces a spawn to closed facts: tool, role, product files, stream copy", () => {
    assert.deepEqual(describeSpawn("/usr/bin/python3", [YTDLP, "--x", "--version"]).role, "runtime-probe");
    assert.deepEqual(describeSpawn("/usr/bin/python3", [YTDLP, "--dump-single-json", "u"]).role, "analysis");
    assert.deepEqual(describeSpawn("/usr/bin/python3", [YTDLP, "--format=x", "u"]).role, "acquisition");
    assert.equal(describeSpawn("/usr/bin/python3", ["/tmp/other.py"]).tool, "other");
    assert.equal(describeSpawn("/usr/bin/ffmpeg", ["-version"]).role, "capability-probe");
    const probe = describeSpawn("/usr/bin/ffprobe", ["-i", "/tmp/videofetch/jobs/j/video-source.mp4"]);
    assert.deepEqual([probe.tool, probe.role, probe.touched], ["ffprobe", "media", ["video-source.mp4"]]);
    const merge = describeSpawn("/usr/bin/ffmpeg", [
      "-n", "-i", "/w/video-source.mp4", "-i", "/w/audio-source.m4a", "-c:v", "copy", "-c:a", "copy", "/w/merged.mp4",
    ]);
    assert.deepEqual([merge.streamCopy, merge.refusesOverwrite], [true, true]);
    assert.deepEqual(merge.touched, ["video-source.mp4", "audio-source.m4a", "merged.mp4"]);
    const transcode = describeSpawn("/usr/bin/ffmpeg", ["-n", "-i", "a", "-c:v", "libx264", "-c:a", "copy", "o"]);
    assert.equal(transcode.streamCopy, false);
    const overwrite = describeSpawn("/usr/bin/ffmpeg", ["-y", "-i", "a", "-c:v", "copy", "-c:a", "copy", "o"]);
    assert.equal(overwrite.refusesOverwrite, false);
  });

  it("classifies the job directory by the pinned FragmentFD grammar, independently", () => {
    for (const [name, kind] of [
      ["video-source.mp4", "final"],
      ["video-source.mp4.part", "aggregate"],
      ["video-source.mp4.ytdl", "bookkeeping"],
      ["video-source.mp4.part-Frag3.part", "fragment-in-flight"],
      ["audio-source.m4a.part-Frag12", "fragment-complete"],
      ["merged.mp4", "output"],
      ["video-source.mp4.part-Frag0", "unexpected"],
      ["video-source.mp4.part-Frag3.part.part", "unexpected"],
      ["video-source.webm", "unexpected"],
      ["notes.txt", "unexpected"],
    ]) {
      assert.equal(classifyWorkspaceEntry(name), kind, name);
    }
  });

  it("reads the downloader identity as closed tags and one integer, never line text", () => {
    const dash = downloaderIdentity(
      "[generic] Extracting URL: http://127.0.0.1:1/x.mpd\n[info] X: Downloading 1 format(s): X\n" +
        "[dashsegments] Total fragments: 5\n[download] Destination: /tmp/videofetch/jobs/j/video-source.mp4\n",
    );
    assert.deepEqual(dash.tags, ["dashsegments", "download", "generic", "info"]);
    assert.deepEqual(dash.fragmentDownloaders, ["DashSegmentsFD"]);
    assert.deepEqual(dash.totalFragments, [5]);
    assert.deepEqual(dash.unexpectedTags, []);
    assert.ok(!JSON.stringify(dash).includes("127.0.0.1") && !JSON.stringify(dash).includes("/tmp"));
    const other = downloaderIdentity("[ffmpeg] Merging formats\n[hlsnative] Total fragments: 3\n[Fixup M4a] x\n");
    assert.deepEqual(other.unexpectedTags, ["<other>", "ffmpeg", "hlsnative"]);
    assert.deepEqual(other.totalFragments, []);
    assert.deepEqual(downloaderIdentity("[download] Destination: x\n").fragmentDownloaders, []);
  });

  it("observes every spawn with the status read at the call, and forwards it untouched", async () => {
    let status = "downloading";
    const observer = installSpawnObserver({ context: () => ({ status, phase: "acquisition" }) });
    try {
      // The ESM binding a product module holds is the observed one.
      const { spawn } = await import("node:child_process");
      const run = () =>
        new Promise((resolvePromise, reject) => {
          const child = spawn(process.execPath, ["-e", "process.stdout.write('ok')"], { stdio: ["ignore", "pipe", "ignore"] });
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("error", reject);
          child.on("exit", (code) => resolvePromise({ code, out }));
        });
      assert.deepEqual(await run(), { code: 0, out: "ok" });
      status = "processing";
      await run();
      const records = observer.records();
      assert.deepEqual(records.map((r) => r.status), ["downloading", "processing"]);
      assert.ok(records.every((r) => r.tool === "other" && r.phase === "acquisition"));
      assert.equal(typeof observer.originalSpawn, "function");
    } finally {
      observer.uninstall();
    }
    const { spawn } = await import("node:child_process");
    assert.equal(spawn, observer.originalSpawn, "uninstall restores the original binding");
  });

  it("records the acquisition policy and identity through the real runner seam", async () => {
    const ledger = createYtdlpLedger(async () => ({ code: 0, stdout: "[dashsegments] Total fragments: 3\n", stderr: "" }));
    ledger.setPhase("acquisition");
    await ledger.runner({
      command: "/usr/bin/python3",
      args: [
        YTDLP, "--downloader=native", "--fixup=never", "--concurrent-fragments=1", "--no-keep-fragments",
        "--abort-on-unavailable-fragments", "--ffmpeg-location=/nonexistent/videofetch-yt-dlp-no-ffmpeg",
        "--format=x[acodec=\"none\"]", "--output=/w/video-source.%(ext)s", "u",
      ],
    });
    const [call] = ledger.acquisitions();
    assert.ok(Object.values(call.policy).every((v) => v === true));
    assert.deepEqual(call.identity.totalFragments, [3]);
    assert.equal(call.template, "/w/video-source.%(ext)s");
  });
});

// ── The evidence ───────────────────────────────────────────────────────────

describe("DASH-01 evidence", () => {
  const input = (overrides = {}) => ({
    verdict: "PASS",
    startedAt: "2026-09-29T00:00:00.000Z",
    finishedAt: "2026-09-29T00:00:30.000Z",
    source: { commit: SOURCE, tree: TREE, contextClean: true },
    image: { candidateTag: TAG, imageId: IMAGE_ID, runSubject: IMAGE_ID },
    network: { observedInterfaceNames: ["lo"] },
    toolchain: { node: "v22.23.2" },
    fixture: {},
    cases: {},
    negativeCases: {},
    checks: DASH01_MANDATORY_CHECKS.map((name) => ({ name, ok: true, detail: null })),
    ...overrides,
  });

  it("requires every case check for BOTH pairings, the negatives, preflight, fixture and identity", () => {
    assert.equal(DASH01_RELEASE_EVIDENCE_SCHEMA, "dash01-release-image-full-path-02");
    for (const caseName of DASH_CASES) {
      for (const name of DASH01_CASE_CHECKS) assert.ok(DASH01_MANDATORY_CHECKS.includes(`${caseName}/${name}`));
    }
    for (const name of [
      "dash-dash/acquisition/video-used-the-native-dash-fragment-downloader",
      "dash-dash/acquisition/no-fragment-residue-at-processing-entry",
      "dash-dash/input/video-ffprobe-1920x1080-video-only",
      "dash-dash/merge/one-real-ffmpeg-stream-copy",
      "dash-dash/output/resolution-is-1920x1080",
      "dash-dash/output/exactly-one-audio-stream",
      "dash-dash/lifecycle/no-media-tool-while-downloading",
      "dash-progressive/workspace/processing-peak-within-twice-the-limit",
      "negative/fragment-guard/stopped-inside-the-held-fragment",
      "negative/missing-fragment/aborted-not-skipped",
      "release/run-subject-is-candidate-image-id",
      "preflight/pinned-dash-fragment-downloader-is-dashsegments",
      // -02: the synchronization oracle (SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001).
      "fixture/timing-oracle-established-before-the-job",
      "fixture/both-pairings-carry-a-discriminating-av-offset",
      "dash-dash/merge/sync-policy-is-the-pre-job-decision",
      "dash-dash/sync/relative-offset-preserved",
      "dash-progressive/sync/relative-offset-preserved",
      "dash-progressive/sync/no-media-hidden-or-unhidden",
      "dash-dash/sync/each-stream-shifted-by-one-constant",
      "dash-dash/sync/no-leading-gap",
      "dash-progressive/sync/stream-spans-preserved",
    ]) {
      assert.ok(DASH01_MANDATORY_CHECKS.includes(name), name);
    }
    assert.equal(new Set(DASH01_MANDATORY_CHECKS).size, DASH01_MANDATORY_CHECKS.length, "no duplicates");
  });

  it("emits a PASS only when every mandatory check is present once and passing", () => {
    assert.equal(buildDashReleaseEvidence(input()).verdict, "PASS");
    const without = input();
    without.checks = without.checks.filter((c) => c.name !== "dash-dash/output/resolution-is-1920x1080");
    assert.throws(() => buildDashReleaseEvidence(without), /refusing to emit a PASS/);
    // -02: a merge that erased the 83.3 ms offset cannot PASS.
    const desynced = input();
    desynced.checks = desynced.checks.map((c) => (c.name === "dash-progressive/sync/relative-offset-preserved" ? { ...c, ok: false } : c));
    assert.throws(() => buildDashReleaseEvidence(desynced), /refusing to emit a PASS/);
    const failing = input();
    failing.checks = failing.checks.map((c) => (c.name === "dash-progressive/output/exactly-one-audio-stream" ? { ...c, ok: false } : c));
    assert.throws(() => buildDashReleaseEvidence(failing), /refusing to emit a PASS/);
    assert.equal(buildDashReleaseEvidence({ ...failing, verdict: "FAIL" }).verdict, "FAIL", "a failure stays reportable");
    const duplicated = input();
    duplicated.checks = [...duplicated.checks, duplicated.checks[0]];
    assert.throws(() => buildDashReleaseEvidence(duplicated), /refusing to emit a PASS/);
  });

  it("refuses to emit private fixture material, a URL, a temporary path or a forbidden field", () => {
    for (const leak of [
      { fixture: { id: DASH_SYNTHETIC_FORMAT_IDS.video } },
      { fixture: { route: dashSegmentRoute("video", 1) } },
      { fixture: { where: "http://127.0.0.1:4000/x" } },
      { fixture: { where: "/tmp/videofetch/jobs/j" } },
      { cases: { "dash-dash": { selector: "--format=x" } } },
    ]) {
      assert.throws(() => buildDashReleaseEvidence(input(leak)), /private fixture material/, JSON.stringify(leak));
    }
    assert.throws(() => buildDashReleaseEvidence(input({ fixture: { argv: ["x"] } })), /'\$\.fixture\.argv' field/);
    assert.throws(() => buildDashReleaseEvidence(input({ fixture: { stderr: "x" } })), /field/);
  });

  it("never emits a record for an unverified source", () => {
    assert.throws(() => buildDashReleaseEvidence(input({ source: { commit: "abc", tree: TREE, contextClean: true } })), /source identity/);
    assert.throws(() => buildDashReleaseEvidence(input({ source: { commit: SOURCE, tree: TREE, contextClean: false } })), /source identity/);
  });

  it("validates a parsed child against the parent's observations", () => {
    const record = JSON.parse(JSON.stringify(buildDashReleaseEvidence(input())));
    const expected = { sourceCommit: SOURCE, sourceTree: TREE, candidateTag: TAG, candidateImageId: IMAGE_ID };
    assert.deepEqual(validateDashReleaseChildRecord(record, expected), []);
    assert.ok(validateDashReleaseChildRecord({ ...record, verdict: "FAIL" }, expected).length > 0);
    assert.ok(validateDashReleaseChildRecord(record, { ...expected, candidateImageId: `sha256:${"b".repeat(64)}` }).length > 0);
    assert.ok(validateDashReleaseChildRecord(null, expected).length > 0);
  });
});

// ── The orchestrator's argv ────────────────────────────────────────────────

describe("DASH-01 orchestrator argv", () => {
  const good = [
    "--evidence", "/report/dash01.json", "--source-commit", SOURCE, "--source-tree", TREE, "--source-context-clean",
    "--candidate-tag", TAG, "--candidate-image-id", IMAGE_ID, "--run-image-id", IMAGE_ID,
  ];

  it("takes exactly the parent's identity flags", () => {
    const opts = parseArgv(good);
    assert.deepEqual(
      [opts.sourceCommit, opts.sourceTree, opts.sourceContextClean, opts.candidateTag, opts.candidateImageId, opts.runImageId],
      [SOURCE, TREE, true, TAG, IMAGE_ID, IMAGE_ID],
    );
  });

  it("refuses a missing, repeated, abbreviated or unknown flag, and a non-plain evidence name", () => {
    const without = (flag, withValue = true) => {
      const args = [...good];
      args.splice(args.indexOf(flag), withValue ? 2 : 1);
      return args;
    };
    assert.throws(() => parseArgv(without("--run-image-id")), /--run-image-id is required/);
    assert.throws(() => parseArgv(without("--source-context-clean", false)), /--source-context-clean is required/);
    assert.throws(() => parseArgv([...good, "--run-image-id", IMAGE_ID]), /given twice/);
    assert.throws(() => parseArgv(good.map((a) => (a === SOURCE ? SOURCE.slice(0, 12) : a))), /full 40-hex/);
    assert.throws(() => parseArgv([...good, "--family", "mp4"]), /unknown argument/);
    assert.throws(() => parseArgv(good.map((a) => (a === "/report/dash01.json" ? "report/x.json" : a))), /absolute path/);
  });
});
