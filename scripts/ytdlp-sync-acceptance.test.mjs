// SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001 — self-tests for the
// split-merge timing oracle (`lib/merge-timing.mjs`), the SYNC-01 matrix
// (`fixtures/sync-media.mjs`) and its record (`lib/sync-evidence.mjs`).
//
// Pure: no FFmpeg, no Docker. The real-media behaviour is the SYNC-01,
// SPLIT-06 and DASH-01 children's, inside the release image.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  alignByPayload,
  describeMergeSync,
  evaluateMergeTiming,
  expectedMergeSync,
  firstPresented,
  fixtureOpusCodecDelayNs,
  formatSixDecimalSeconds,
  FORBIDDEN_MERGE_TIMESTAMP_FLAGS,
  mergeSyncMatches,
  mergeTimingProbeArgs,
  mp4MovieTimescale,
  opusCompensationMicros,
  pairSourceTiming,
  parsePacketTimeline,
  rational,
  ratToMicros,
  streamShift,
} from "../deploy/acceptance/ytdlp-generic/lib/merge-timing.mjs";
import {
  historicalSplitMergeArgs,
  msToSeconds,
  SYNC_CASES,
  SYNC_CONTROL_CASES,
  SYNC_SENSITIVITY_CASES,
  syncAudioArgs,
  syncHalfNames,
  syncVideoArgs,
} from "../deploy/acceptance/ytdlp-generic/fixtures/sync-media.mjs";
import {
  buildSyncReleaseEvidence,
  SYNC01_MANDATORY_CHECKS,
  SYNC01_RELEASE_EVIDENCE_SCHEMA,
  syncCaseChecks,
  validateSyncReleaseChildRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/sync-evidence.mjs";

// ── A tiny synthetic packet timeline, as ffprobe would print it ────────────

let hashSeed = 0;
const hash = () => `SHA256:${String((hashSeed += 1)).padStart(64, "0")}`;

/** `packets`: [pts, dts, duration, flags?, hash?][] for ONE stream. */
function stream(kind, timeBase, packets, index = 0) {
  return {
    streams: [{ index, codec_type: kind, codec_name: kind === "video" ? "h264" : "aac", time_base: timeBase, extradata_hash: `SHA256:${kind}` }],
    packets: packets.map(([pts, dts, duration, flags = "__", data = hash()]) => ({
      stream_index: index, pts, dts, duration, flags, data_hash: data,
    })),
  };
}
function merged(video, audio) {
  return {
    streams: [{ ...video.streams[0], index: 0 }, { ...audio.streams[0], index: 1 }],
    packets: [
      ...video.packets.map((p) => ({ ...p, stream_index: 0 })),
      ...audio.packets.map((p) => ({ ...p, stream_index: 1 })),
    ],
  };
}
/** The same packets (same payload hashes), every PTS/DTS moved by `ticks`. */
function shifted(doc, ticks) {
  return { ...doc, packets: doc.packets.map((p) => ({ ...p, pts: p.pts + ticks, dts: p.dts + ticks })) };
}

const VIDEO_TB = "1/15360";
const AUDIO_TB = "1/48000";
const videoAt = (startTicks) =>
  stream("video", VIDEO_TB, Array.from({ length: 6 }, (_, i) => [startTicks + i * 512, startTicks + i * 512, 512, i === 0 ? "K_" : "__"]));
const audioAt = (startTicks, priming = false) =>
  stream("audio", AUDIO_TB, [
    ...(priming ? [[startTicks - 1024, startTicks - 1024, 1024, "KD"]] : []),
    ...Array.from({ length: 6 }, (_, i) => [startTicks + i * 1024, startTicks + i * 1024, 1024, "K_"]),
  ]);

describe("merge timing oracle: arithmetic and parsing", () => {
  it("keeps time exact and rounds only the evidence summary, halves away from zero", () => {
    assert.equal(ratToMicros(rational(1n, 3n)), 333_333);
    assert.equal(ratToMicros(rational(1n, 2_000_000n)), 1);
    assert.equal(ratToMicros(rational(-1n, 2_000_000n)), -1);
    assert.equal(ratToMicros(rational(0n, 7n)), 0);
    assert.equal(ratToMicros(rational(83_333_333n, 1_000_000_000n)), 83_333);
  });

  it("parses one stream per kind, with exact time bases and discard flags", () => {
    const t = parsePacketTimeline(JSON.stringify(audioAt(0, true)));
    assert.equal(t.streamCount, 1);
    assert.equal(t.video, null);
    assert.equal(t.audio.packets.length, 7);
    assert.equal(t.audio.packets[0].discard, true);
    assert.deepEqual(firstPresented(t.audio), rational(0n, 1n), "a discard-flagged priming packet is not presented");
  });

  it("refuses two streams of one kind, an unknown kind, a missing hash or an unparseable time base", () => {
    const two = { streams: [...videoAt(0).streams, { ...videoAt(0).streams[0], index: 1 }], packets: [] };
    assert.throws(() => parsePacketTimeline(two), /more than one video/);
    assert.throws(() => parsePacketTimeline({ streams: [{ index: 0, codec_type: "subtitle", time_base: "1/1000" }], packets: [] }), /unexpected stream kind/);
    const noHash = videoAt(0);
    delete noHash.packets[2].data_hash;
    assert.throws(() => parsePacketTimeline(noHash), /no payload hash/);
    const badTb = videoAt(0);
    badTb.streams[0].time_base = "0/1";
    assert.throws(() => parsePacketTimeline(badTb), /time base/);
  });

  it("builds the harness probe argv with a file-only whitelist and an explicit demuxer", () => {
    const args = mergeTimingProbeArgs("mov", "/x/merged.mp4");
    assert.deepEqual(args.slice(0, 6), ["-v", "error", "-protocol_whitelist", "file", "-f", "mov"]);
    assert.ok(args.includes("-show_data_hash"));
    assert.throws(() => mergeTimingProbeArgs("mpegts", "/x"), /unsupported demuxer/);
  });

  it("reads the mvhd timescale of an MP4, and nothing else", () => {
    const box = (type, body) => {
      const b = Buffer.alloc(8 + body.length);
      b.writeUInt32BE(8 + body.length, 0);
      b.write(type, 4, "latin1");
      body.copy(b, 8);
      return b;
    };
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1000, 12); // version 0: timescale after version/flags/creation/modification
    const file = Buffer.concat([box("ftyp", Buffer.alloc(8)), box("moov", box("mvhd", mvhd)), box("mdat", Buffer.alloc(4))]);
    assert.equal(mp4MovieTimescale(file), 1000);
    assert.equal(mp4MovieTimescale(Buffer.from("not an mp4")), null);
  });
});

describe("merge timing oracle: verdicts", () => {
  const parse = (doc) => parsePacketTimeline(doc);

  it("accepts a merge that preserved a 478 ms audio-late offset exactly", () => {
    const v = videoAt(0);
    const a = audioAt(22_944); // 478 ms at 48 kHz
    const verdict = evaluateMergeTiming({ videoInput: parse(v), audioInput: parse(a), output: parse(merged(v, a)), movieTimescale: 1000 });
    assert.equal(verdict.measurable, true);
    assert.equal(verdict.sourceRelativeUs, 478_000);
    assert.equal(verdict.outputRelativeUs, 478_000);
    assert.equal(verdict.relativeTimingPreserved, true);
    assert.equal(verdict.payloadIdentical, true);
    assert.equal(verdict.noMediaHiddenOrUnhidden, true);
    assert.equal(verdict.noLeadingGap, true);
    // Tolerance: one tick of each output time base + one movie-timescale tick.
    assert.equal(verdict.toleranceUs, ratToMicros(rational(1n, 15_360n)) + 21 + 1000);
  });

  it("detects a merge that zeroed each input independently", () => {
    const v = videoAt(0);
    const a = audioAt(22_944);
    const verdict = evaluateMergeTiming({
      videoInput: parse(v), audioInput: parse(a), output: parse(merged(v, shifted(a, -22_944))), movieTimescale: 1000,
    });
    assert.equal(verdict.relativeTimingPreserved, false);
    assert.equal(verdict.packetShiftDeltaUs, -478_000);
    assert.equal(verdict.payloadIdentical, true, "a pure timestamp defect keeps every payload");
  });

  it("accepts a common shift of both streams (the shared base removed)", () => {
    const v = videoAt(155_136);
    const a = audioAt(507_744);
    const out = merged(shifted(v, -155_136), shifted(a, -484_800)); // both by 10.1 s
    const verdict = evaluateMergeTiming({ videoInput: parse(v), audioInput: parse(a), output: parse(out), movieTimescale: 1000 });
    assert.equal(verdict.relativeTimingPreserved, true);
    assert.equal(verdict.videoShiftUs, -10_100_000);
  });

  it("detects un-hidden priming: the source's discarded packet presented in the output", () => {
    const v = videoAt(0);
    const a = audioAt(0, true);
    const out = merged(v, { ...a, packets: a.packets.map((p) => ({ ...p, flags: p.flags.replace("D", "_") })) });
    const verdict = evaluateMergeTiming({ videoInput: parse(v), audioInput: parse(a), output: parse(out), movieTimescale: 1000 });
    assert.equal(verdict.noMediaHiddenOrUnhidden, false);
  });

  it("detects trimmed lead-in: leading packets hidden or dropped in the output", () => {
    const v = videoAt(0);
    const a = audioAt(0);
    const trimmed = { ...a, packets: a.packets.slice(2) };
    const verdict = evaluateMergeTiming({ videoInput: parse(v), audioInput: parse(a), output: parse(merged(v, trimmed)), movieTimescale: 1000 });
    assert.equal(verdict.noMediaHiddenOrUnhidden, false);
    assert.equal(verdict.payloadIdentical, false);
    assert.equal(alignByPayload(parse(a).audio, parse(trimmed).audio).offset, 2);
  });

  it("detects a stream whose packets did not move by one constant", () => {
    const a = audioAt(0);
    const jittered = { ...a, packets: a.packets.map((p, i) => (i === 3 ? { ...p, pts: p.pts + 1 } : p)) };
    assert.equal(streamShift(parse(a).audio, parse(jittered).audio).constant, false);
  });

  it("detects a leading gap: both tracks delayed by a large common offset", () => {
    const v = videoAt(0);
    const a = audioAt(0);
    const out = merged(shifted(v, 15_360 * 10), shifted(a, 48_000 * 10));
    const verdict = evaluateMergeTiming({ videoInput: parse(v), audioInput: parse(a), output: parse(out), movieTimescale: 1000 });
    assert.equal(verdict.relativeTimingPreserved, true);
    assert.equal(verdict.noLeadingGap, false);
  });

  it("reports an unmeasurable merge rather than guessing", () => {
    assert.equal(evaluateMergeTiming({ videoInput: parse(videoAt(0)), audioInput: parse(audioAt(0)), output: parse(videoAt(0)) }).measurable, false);
  });

  it("calls a pair discriminating only beyond rounding", () => {
    assert.equal(pairSourceTiming(parse(videoAt(0)), parse(audioAt(0))).discriminating, false);
    assert.equal(pairSourceTiming(parse(videoAt(0)), parse(audioAt(48))).discriminating, false, "1 ms is rounding");
    assert.equal(pairSourceTiming(parse(videoAt(1280)), parse(audioAt(0))).discriminating, true, "83.3 ms is not");
  });
});

describe("merge argv: the closed synchronization description", () => {
  const argv = (input0, input1, tail = []) => [
    "-n", "-nostdin", "-v", "error",
    ...input0, "-protocol_whitelist", "file", "-f", "mov", "-i", "/w/v.mp4",
    ...input1, "-protocol_whitelist", "file", "-f", "mov", "-i", "/w/a.m4a",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy", ...tail, "-f", "mp4", "/w/merged.mp4",
  ];

  it("reads the input options of each input and nothing else", () => {
    assert.deepEqual(describeMergeSync(argv([], ["-isync", "0"])), { inputCount: 2, input0: [], input1: ["-isync", "0"], forbiddenFlags: [] });
    assert.deepEqual(describeMergeSync(argv(["-isync", "1"], [])), { inputCount: 2, input0: ["-isync", "1"], input1: [], forbiddenFlags: [] });
    assert.deepEqual(describeMergeSync(argv([], ["-itsoffset", "0.006500", "-isync", "0"])).input1, ["-itsoffset", "0.006500", "-isync", "0"]);
  });

  it("never retains an -itsoffset value outside the application's exact form", () => {
    assert.deepEqual(describeMergeSync(argv([], ["-itsoffset", "upstream text", "-isync", "0"])).input1, ["-itsoffset", "<other>", "-isync", "0"]);
    assert.deepEqual(describeMergeSync(argv([], ["-itsoffset", "0.5", "-isync", "0"])).input1, ["-itsoffset", "<other>", "-isync", "0"]);
  });

  it("names every forbidden timestamp flag wherever it appears", () => {
    for (const flag of FORBIDDEN_MERGE_TIMESTAMP_FLAGS) {
      const tail = ["-t", "-to", "-ss", "-output_ts_offset", "-avoid_negative_ts"].includes(flag) ? [flag, "x"] : [flag];
      assert.deepEqual(describeMergeSync(argv([], ["-isync", "0"], tail)).forbiddenFlags, [flag], flag);
    }
    const historical = historicalSplitMergeArgs("mp4", "/w/v.mp4", "/w/a.m4a", "/w/merged.mp4");
    assert.deepEqual(describeMergeSync(historical), { inputCount: 2, input0: [], input1: [], forbiddenFlags: [] });
  });

  it("derives the expected policy from the measured start order, the video on a tie", () => {
    const t = (doc) => parsePacketTimeline(doc);
    assert.deepEqual(expectedMergeSync({ target: "mp4", videoInput: t(videoAt(0)), audioInput: t(audioAt(22_944)) }), { input0: [], input1: ["-isync", "0"] });
    assert.deepEqual(expectedMergeSync({ target: "mp4", videoInput: t(videoAt(1280)), audioInput: t(audioAt(0)) }), { input0: ["-isync", "1"], input1: [] });
    assert.deepEqual(expectedMergeSync({ target: "mp4", videoInput: t(videoAt(0)), audioInput: t(audioAt(0)) }), { input0: [], input1: ["-isync", "0"] });
    assert.deepEqual(expectedMergeSync({ target: "webm", videoInput: null, audioInput: null, opusCodecDelayNs: 6_500_000 }), { input0: [], input1: ["-itsoffset", "0.006500", "-isync", "0"] });
    assert.deepEqual(expectedMergeSync({ target: "webm", videoInput: null, audioInput: null }), { input0: [], input1: ["-isync", "0"] });
  });

  it("matches only the exact expected policy with no forbidden flag", () => {
    const expected = { input0: ["-isync", "1"], input1: [] };
    assert.equal(mergeSyncMatches(describeMergeSync(argv(["-isync", "1"], [])), expected), true);
    assert.equal(mergeSyncMatches(describeMergeSync(argv([], ["-isync", "0"])), expected), false, "the wrong direction");
    assert.equal(mergeSyncMatches(describeMergeSync(argv([], [])), expected), false, "no policy at all");
    assert.equal(mergeSyncMatches(describeMergeSync(argv(["-isync", "1"], [], ["-shortest"])), expected), false, "-shortest");
    assert.equal(mergeSyncMatches(null, expected), false);
  });

  it("computes the Opus compensation through the 48 kHz clock and formats it exactly", () => {
    assert.equal(opusCompensationMicros(6_500_000), 6500);
    assert.equal(opusCompensationMicros(0), 0);
    assert.equal(formatSixDecimalSeconds(6500), "0.006500");
    assert.equal(formatSixDecimalSeconds(1_365_313), "1.365313");
  });

  it("reads a pinned FFmpeg-written Opus header's CodecDelay, and none from Vorbis", () => {
    const header = (codec) =>
      readFileSync(join(import.meta.dirname, "../src/services/processing/testdata", `pinned-matroska-header-${codec}-audio.bin`));
    assert.equal(fixtureOpusCodecDelayNs(header("opus")), 6_500_000);
    assert.equal(fixtureOpusCodecDelayNs(header("vorbis")), 0);
  });
});

describe("SYNC-01 matrix", () => {
  const byName = Object.fromEntries(SYNC_CASES.map((c) => [c.name, c]));

  it("covers every required MP4 and WebM shape", () => {
    const required = {
      "zero-aligned progressive MP4": "mp4-prog-zero",
      "B-frame zero-aligned MP4 (negative DTS)": "mp4-prog-zero-bframes",
      "audio-late progressive": "mp4-prog-audio-late",
      "video-late progressive": "mp4-prog-video-late",
      "shared non-zero base": "mp4-prog-shared-base",
      "audio-leading": "mp4-prog-audio-leads",
      "fragmented DASH-like fMP4 with B-frame delay": "mp4-frag-dashlike-bframes",
      "non-zero tfdt": "mp4-frag-tfdt-audio-late",
      "edit-list pre-roll": "mp4-prog-preroll-cut",
      "zero-aligned Opus": "webm-opus-zero",
      "audio-late Opus": "webm-opus-audio-late",
      "video-late Opus": "webm-opus-video-late",
      "shared base Opus": "webm-opus-shared-base",
      "audio-leading Opus": "webm-opus-audio-leads",
      "Vorbis zero-aligned": "webm-vorbis-zero",
      "Vorbis offset": "webm-vorbis-audio-late",
    };
    for (const [label, name] of Object.entries(required)) assert.ok(byName[name], label);
    assert.equal(byName["mp4-frag-tfdt-audio-late"].layout, "frag-abs");
    assert.equal(byName["mp4-frag-dashlike-bframes"].layout, "frag-auto");
    assert.equal(byName["mp4-prog-preroll-cut"].prerollMs, 500);
    assert.equal(byName["webm-vorbis-zero"].audioCodec, "vorbis");
    assert.equal(new Set(SYNC_CASES.map((c) => c.name)).size, SYNC_CASES.length);
  });

  it("carries duration discriminators whose earlier-starting half is the shorter", () => {
    for (const name of ["mp4-prog-audio-leads-short", "mp4-prog-video-leads-short"]) {
      const c = byName[name];
      assert.equal(c.kind, "duration");
      const audioFirst = c.audioStartMs < c.videoStartMs;
      const earlier = audioFirst ? c.audioEndMs - c.audioStartMs : c.videoEndMs - c.videoStartMs;
      const later = audioFirst ? c.videoEndMs - c.videoStartMs : c.audioEndMs - c.audioStartMs;
      assert.ok(earlier < later, name);
    }
  });

  it("names the zero-aligned controls and the oracle-sensitivity cases", () => {
    assert.deepEqual([...SYNC_CONTROL_CASES], ["mp4-prog-zero", "mp4-prog-zero-bframes", "mp4-prog-preroll-cut", "webm-opus-zero", "webm-vorbis-zero"]);
    for (const name of SYNC_SENSITIVITY_CASES) assert.equal(byName[name].kind, "offset");
  });

  it("formats integer milliseconds as exact decimal seconds", () => {
    assert.equal(msToSeconds(0), "0");
    assert.equal(msToSeconds(478), "0.478");
    assert.equal(msToSeconds(10_578), "10.578");
    assert.equal(msToSeconds(10_100), "10.1");
    assert.equal(msToSeconds(-500), "-0.5");
    assert.throws(() => msToSeconds(0.5), /integer/);
  });

  it("places each half's container start at base + start, the event on one presentation timeline", () => {
    const c = byName["mp4-prog-shared-base"];
    const v = syncVideoArgs(c, "/o/v.mp4");
    const a = syncAudioArgs(c, "/o/a.m4a");
    assert.equal(v[v.indexOf("-output_ts_offset") + 1], "10.1");
    assert.equal(a[a.indexOf("-output_ts_offset") + 1], "10.578");
    assert.match(v.find((x) => x.startsWith("testsrc2")), /eq\(n,57\)/, "the flash at presentation 2.0 s is frame 57 of a half starting at 0.1 s");
    assert.match(a.find((x) => x.startsWith("aevalsrc")), /between\(t,1\.422,1\.442\)/, "the click at presentation 2.0 s");
    const preroll = syncVideoArgs(byName["mp4-prog-preroll-cut"], "/o/v.mp4");
    assert.equal(preroll[preroll.indexOf("-output_ts_offset") + 1], "-0.5");
    assert.match(preroll.find((x) => x.startsWith("testsrc2")), /eq\(n,75\)/);
    assert.ok(!syncVideoArgs(byName["mp4-prog-zero"], "/o/v.mp4").includes("-output_ts_offset"));
    assert.ok(syncVideoArgs(byName["mp4-frag-tfdt-audio-late"], "/o/v.mp4").join(" ").includes("+frag_discont"));
    assert.ok(syncAudioArgs(byName["webm-vorbis-zero"], "/o/a.webm").includes("libvorbis"));
    assert.ok(syncAudioArgs(byName["webm-opus-zero"], "/o/a.webm").includes("libopus"));
  });

  it("refuses video times that are not whole frames", () => {
    assert.throws(() => syncVideoArgs({ ...byName["mp4-prog-zero"], videoStartMs: 450 }, "/o/v.mp4"), /100 ms multiples/);
  });

  it("freezes the historical argv exactly as main 73176b20 built it", () => {
    assert.deepEqual(historicalSplitMergeArgs("mp4", "/w/v.mp4", "/w/a.m4a", "/w/merged.mp4"), [
      "-n", "-nostdin", "-v", "error",
      "-protocol_whitelist", "file", "-f", "mov", "-i", "/w/v.mp4",
      "-protocol_whitelist", "file", "-f", "mov", "-i", "/w/a.m4a",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy",
      "-map_metadata", "-1", "-map_chapters", "-1",
      "-movflags", "+faststart",
      "-f", "mp4", "/w/merged.mp4",
    ]);
    assert.deepEqual(historicalSplitMergeArgs("webm", "/w/v.webm", "/w/a.webm", "/w/merged.webm").slice(-3), ["-f", "webm", "/w/merged.webm"]);
    assert.deepEqual(syncHalfNames("webm"), { video: "video-source.webm", audio: "audio-source.webm", output: "merged.webm" });
  });
});

describe("SYNC-01 evidence", () => {
  const SOURCE = "a".repeat(40);
  const TREE = "b".repeat(40);
  const IMAGE = `sha256:${"c".repeat(64)}`;
  const TAG = `videofetch-worker:split07-${SOURCE.slice(0, 12)}-local-test`;
  const input = (overrides = {}) => ({
    verdict: "PASS",
    startedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: "2026-10-02T00:00:23.000Z",
    source: { commit: SOURCE, tree: TREE, contextClean: true },
    image: { candidateTag: TAG, imageId: IMAGE, runSubject: IMAGE },
    network: { observedInterfaceNames: ["lo"] },
    toolchain: {},
    cases: {},
    sensitivity: {},
    checks: SYNC01_MANDATORY_CHECKS.map((name) => ({ name, ok: true, detail: null })),
    ...overrides,
  });

  it("requires every case's kind-specific checks and the oracle-sensitivity control", () => {
    assert.equal(SYNC01_RELEASE_EVIDENCE_SCHEMA, "sync01-release-image-merge-timing-01");
    for (const c of SYNC_CASES) {
      for (const name of syncCaseChecks(c.kind)) assert.ok(SYNC01_MANDATORY_CHECKS.includes(`${c.name}/${name}`), `${c.name}/${name}`);
    }
    assert.ok(SYNC01_MANDATORY_CHECKS.includes("mp4-prog-zero/compat/output-identical-to-the-historical-merge"));
    assert.ok(!SYNC01_MANDATORY_CHECKS.includes("mp4-prog-audio-late/compat/output-identical-to-the-historical-merge"));
    assert.ok(SYNC01_MANDATORY_CHECKS.includes("mp4-prog-audio-leads-short/fixture/earlier-starting-half-is-the-shorter"));
    assert.ok(SYNC01_MANDATORY_CHECKS.includes("oracle/detects-per-input-zeroing/mp4-prog-audio-late"));
    assert.ok(SYNC01_MANDATORY_CHECKS.includes("oracle/detects-per-input-zeroing/webm-opus-audio-late"));
    assert.ok(SYNC01_MANDATORY_CHECKS.includes("release/run-subject-is-candidate-image-id"));
    assert.equal(new Set(SYNC01_MANDATORY_CHECKS).size, SYNC01_MANDATORY_CHECKS.length);
    assert.throws(() => syncCaseChecks("other"), /unknown case kind/);
  });

  it("emits a PASS only when every mandatory check is present once and passing", () => {
    assert.equal(buildSyncReleaseEvidence(input()).verdict, "PASS");
    for (const mutate of [
      (checks) => checks.filter((c) => c.name !== "webm-opus-zero/sync/relative-offset-preserved"),
      (checks) => checks.map((c) => (c.name === "mp4-prog-preroll-cut/sync/no-media-hidden-or-unhidden" ? { ...c, ok: false } : c)),
      (checks) => [...checks, { name: "mp4-prog-zero/sync/payload-identical", ok: true, detail: null }],
      (checks) => checks.filter((c) => !c.name.startsWith("oracle/")),
    ]) {
      assert.throws(() => buildSyncReleaseEvidence(input({ checks: mutate(input().checks) })), /refusing to emit a PASS/);
      assert.equal(buildSyncReleaseEvidence(input({ verdict: "FAIL", checks: mutate(input().checks) })).verdict, "FAIL");
    }
  });

  it("refuses a record carrying a workspace path or a URL, and an unverified source", () => {
    assert.throws(() => buildSyncReleaseEvidence(input({ cases: { x: { note: "/tmp/videofetch/sync01" } } })), /forbidden material/);
    assert.throws(() => buildSyncReleaseEvidence(input({ cases: { x: { note: "https://example.com" } } })), /forbidden material/);
    assert.throws(() => buildSyncReleaseEvidence(input({ source: { commit: SOURCE, tree: TREE, contextClean: false } })), /parent-verified/);
  });

  it("validates a PASS for exactly the parent's source and image", () => {
    const record = JSON.parse(JSON.stringify(buildSyncReleaseEvidence(input())));
    const expected = { sourceCommit: SOURCE, sourceTree: TREE, candidateTag: TAG, candidateImageId: IMAGE };
    assert.deepEqual(validateSyncReleaseChildRecord(record, expected), []);
    assert.ok(validateSyncReleaseChildRecord({ ...record, schema: "x" }, expected).length > 0);
    assert.ok(validateSyncReleaseChildRecord(record, { ...expected, sourceTree: "d".repeat(40) }).length > 0);
    assert.ok(validateSyncReleaseChildRecord(null, expected).length > 0);
  });
});
