import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideMergeSync,
  formatMicrosecondsAsSeconds,
  MAX_ABS_MERGE_START_TIME_US,
  MAX_OPUS_CODEC_DELAY_NS,
  mergeSyncInputOptions,
  MergeSyncError,
  opusCodecDelayCompensationUs,
  type MergeSyncDecision,
} from "./merge-sync.ts";

// SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001 — the closed, pure
// cross-input synchronization policy. Every value here is application-owned.

const refuses = (fn: () => unknown) => assert.throws(fn, (err: unknown) => err instanceof MergeSyncError);

describe("MP4 synchronization direction", () => {
  const mp4 = (videoStartUs: number, audioStartUs: number) =>
    decideMergeSync({ target: "mp4", videoStartUs, audioStartUs });

  it("syncs the audio to the video when the video starts first", () => {
    assert.deepEqual(mp4(0, 456_000), { target: "mp4", reference: "video" });
    assert.deepEqual(mp4(10_100_000, 10_556_000), { target: "mp4", reference: "video" });
  });

  it("syncs the video to the audio when the audio starts first", () => {
    assert.deepEqual(mp4(400_000, 0), { target: "mp4", reference: "audio" });
    assert.deepEqual(mp4(83_333, 0), { target: "mp4", reference: "audio" }); // the DASH-01 shape
    assert.deepEqual(mp4(10_500_000, 10_078_000), { target: "mp4", reference: "audio" });
  });

  it("uses the video as the reference on equal starts (byte-identical to the old zero-aligned merge)", () => {
    assert.deepEqual(mp4(0, 0), { target: "mp4", reference: "video" });
    assert.deepEqual(mp4(10_100_000, 10_100_000), { target: "mp4", reference: "video" });
  });

  it("orders negative starts by value, not by magnitude", () => {
    assert.deepEqual(mp4(0, -21_333), { target: "mp4", reference: "audio" });
    assert.deepEqual(mp4(-66_667, 0), { target: "mp4", reference: "video" });
    assert.deepEqual(mp4(-5, -7), { target: "mp4", reference: "audio" });
  });

  it("resolves a one-microsecond difference (the parser's resolution) in both directions", () => {
    assert.equal(mp4(1, 0).reference, "audio");
    assert.equal(mp4(0, 1).reference, "video");
    assert.equal(mp4(-1, 0).reference, "video");
    const edge = MAX_ABS_MERGE_START_TIME_US - 1;
    assert.equal(mp4(edge, edge - 1).reference, "audio");
    assert.equal(mp4(-edge + 1, -edge).reference, "audio");
  });

  it("refuses unusable start times", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, MAX_ABS_MERGE_START_TIME_US, -MAX_ABS_MERGE_START_TIME_US, 2 ** 53]) {
      refuses(() => mp4(bad, 0));
      refuses(() => mp4(0, bad));
    }
    refuses(() => decideMergeSync({ target: "mp4", videoStartUs: "0" as never, audioStartUs: 0 }));
  });

  it("refuses WebM facts on an MP4 decision", () => {
    refuses(() =>
      decideMergeSync({ target: "mp4", videoStartUs: 0, audioStartUs: 0, webmAudio: { codec: "opus", codecDelayNs: 0 } }),
    );
  });
});

describe("WebM synchronization and Opus CodecDelay compensation", () => {
  const webm = (codec: "opus" | "vorbis", codecDelayNs: number, videoStartUs = 0, audioStartUs = -7_000) =>
    decideMergeSync({ target: "webm", videoStartUs, audioStartUs, webmAudio: { codec, codecDelayNs } });

  it("compensates a valid Opus CodecDelay exactly (libopus 312-sample pre-skip = 6.5 ms)", () => {
    assert.deepEqual(webm("opus", 6_500_000), {
      target: "webm",
      reference: "video",
      audioCodecDelayCompensationUs: 6_500,
    });
  });

  it("quantizes the compensation through the 48 kHz Opus clock the round trip uses", () => {
    // 1 ns → 0 samples → 0 µs; 10,417 ns → 0.5 samples → 1 sample (half up) → 20.83 µs → 21 µs.
    assert.equal(opusCodecDelayCompensationUs(1), 0);
    assert.equal(opusCodecDelayCompensationUs(10_417), 21);
    assert.equal(opusCodecDelayCompensationUs(80_000_000), 80_000); // 3840 samples
    assert.equal(opusCodecDelayCompensationUs(MAX_OPUS_CODEC_DELAY_NS), 1_365_313); // 65535 samples
  });

  it("agrees with the release acceptance oracle's own compensation and formatting", async () => {
    // SYNC-01 / SPLIT-06 / DASH-01 derive the EXPECTED `-itsoffset` from the
    // fixture's bytes independently; a drift between the two derivations would
    // make every WebM acceptance fail. Non-literal specifier on purpose (see
    // `hls-execution-plan.test.ts`): the harness is untyped `.mjs`.
    const harness = "../../../deploy/acceptance/ytdlp-generic";
    const oracle = (await import(`${harness}/lib/merge-timing.mjs`)) as {
      opusCompensationMicros(ns: number): number;
      formatSixDecimalSeconds(us: number): string;
    };
    for (const ns of [0, 1, 10_416, 10_417, 6_500_000, 80_000_000, MAX_OPUS_CODEC_DELAY_NS]) {
      const us = opusCodecDelayCompensationUs(ns);
      assert.equal(oracle.opusCompensationMicros(ns), us, `${ns} ns`);
      assert.equal(oracle.formatSixDecimalSeconds(us), formatMicrosecondsAsSeconds(us), `${us} µs`);
    }
  });

  it("does not compensate a zero-delay Opus track", () => {
    assert.deepEqual(webm("opus", 0), { target: "webm", reference: "video", audioCodecDelayCompensationUs: 0 });
  });

  it("does not compensate a Vorbis track", () => {
    assert.deepEqual(webm("vorbis", 0, 0, 0), { target: "webm", reference: "video", audioCodecDelayCompensationUs: 0 });
  });

  it("always syncs the WebM audio to the video, whichever starts first", () => {
    for (const [v, a] of [[0, -7_000], [400_000, -7_000], [0, 464_000], [10_500_000, 10_086_000]] as const) {
      assert.equal(webm("opus", 6_500_000, v, a).reference, "video");
    }
  });

  it("refuses an excessive, negative or non-integer Opus CodecDelay", () => {
    for (const bad of [MAX_OPUS_CODEC_DELAY_NS + 1, 2 ** 53, -1, 1.5, Number.NaN]) refuses(() => webm("opus", bad));
  });

  it("refuses a Vorbis track that declares a CodecDelay (outside every evidenced shape)", () => {
    refuses(() => webm("vorbis", 6_500_000, 0, 0));
  });

  it("refuses a WebM decision without the audio track facts, or with an unknown codec", () => {
    refuses(() => decideMergeSync({ target: "webm", videoStartUs: 0, audioStartUs: 0 }));
    refuses(() =>
      decideMergeSync({ target: "webm", videoStartUs: 0, audioStartUs: 0, webmAudio: { codec: "aac" as never, codecDelayNs: 0 } }),
    );
  });

  it("refuses an unknown target", () => {
    refuses(() => decideMergeSync({ target: "mkv" as never, videoStartUs: 0, audioStartUs: 0 }));
  });
});

describe("synchronization tokens", () => {
  it("maps each closed decision to fixed input-option tokens", () => {
    assert.deepEqual(mergeSyncInputOptions({ target: "mp4", reference: "video" }), { input0: [], input1: ["-isync", "0"] });
    assert.deepEqual(mergeSyncInputOptions({ target: "mp4", reference: "audio" }), { input0: ["-isync", "1"], input1: [] });
    assert.deepEqual(
      mergeSyncInputOptions({ target: "webm", reference: "video", audioCodecDelayCompensationUs: 6_500 }),
      { input0: [], input1: ["-itsoffset", "0.006500", "-isync", "0"] },
    );
    assert.deepEqual(
      mergeSyncInputOptions({ target: "webm", reference: "video", audioCodecDelayCompensationUs: 0 }),
      { input0: [], input1: ["-isync", "0"] },
    );
  });

  it("never emits a forbidden timestamp flag", () => {
    const decisions: MergeSyncDecision[] = [
      { target: "mp4", reference: "video" },
      { target: "mp4", reference: "audio" },
      { target: "webm", reference: "video", audioCodecDelayCompensationUs: 0 },
      { target: "webm", reference: "video", audioCodecDelayCompensationUs: 6_500 },
    ];
    for (const decision of decisions) {
      const { input0, input1 } = mergeSyncInputOptions(decision);
      for (const token of [...input0, ...input1]) {
        assert.ok(
          !["-copyts", "-start_at_zero", "-avoid_negative_ts", "-shortest", "-ss", "-t", "-to", "-output_ts_offset"].includes(token),
          token,
        );
      }
      if (decision.target === "mp4") assert.ok(![...input0, ...input1].includes("-itsoffset"), "no -itsoffset for MP4");
    }
  });

  it("refuses a malformed decision that arrived by a cast", () => {
    const bad = [
      null,
      {},
      { target: "mp4" },
      { target: "mp4", reference: "both" },
      { target: "mp4", reference: 0 },
      { target: "webm", reference: "audio", audioCodecDelayCompensationUs: 0 },
      { target: "webm", reference: "video" },
      { target: "webm", reference: "video", audioCodecDelayCompensationUs: -1 },
      { target: "webm", reference: "video", audioCodecDelayCompensationUs: 1.5 },
      { target: "webm", reference: "video", audioCodecDelayCompensationUs: "6500" },
      { target: "webm", reference: "video", audioCodecDelayCompensationUs: 1_365_314 },
      { target: "mkv", reference: "video" },
    ];
    for (const decision of bad) refuses(() => mergeSyncInputOptions(decision as never));
  });

  it("formats integer microseconds as exact six-decimal seconds", () => {
    assert.equal(formatMicrosecondsAsSeconds(0), "0.000000");
    assert.equal(formatMicrosecondsAsSeconds(6_500), "0.006500");
    assert.equal(formatMicrosecondsAsSeconds(1_365_313), "1.365313");
    for (const bad of [-1, 1.5, Number.NaN]) refuses(() => formatMicrosecondsAsSeconds(bad));
  });
});
