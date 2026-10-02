/**
 * SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001: the closed cross-input
 * timestamp policy for a two-input local stream-copy merge.
 *
 * ─── The defect this exists to correct ─────────────────────────────────────
 *
 * The pinned FFmpeg 5.1.9 gives every input its own offset of
 * `-(that input's start_time)` (`fftools/ffmpeg_opt.c`, `open_input_file`), so
 * a merge of two SEPARATE files with no cross-input policy re-bases each file
 * to zero independently. Any legitimate offset between the video and the audio
 * — an MP4 empty edit, a fragmented `tfdt`, B-frame composition delay without
 * an edit list, a shared non-zero base — is silently erased.
 * `-copyts -start_at_zero` uses the same per-input formula and does not help.
 * `-copyts -avoid_negative_ts make_zero` keeps the offset but shifts by the
 * lowest DTS, which un-hides edit-list-trimmed media (encoder priming, cut
 * pre-roll) in the MP4 output. A FIXED `-isync` direction trims whichever
 * stream starts first. All of that was measured against the pinned runtime by
 * SPLIT-MERGE-TIMESTAMP-PRESERVATION-AUDIT-001.
 *
 * ─── What this module decides, and what it does not ─────────────────────────
 *
 * The application decides only a closed STATE from validated local facts:
 *
 *   mp4   which input is the sync reference — the one that starts first (the
 *         video on a tie). FFmpeg's own `-isync` then re-bases BOTH inputs by
 *         that input's start time, so the relative offset survives, nothing is
 *         trimmed, and the per-track edit lists still hide what the source
 *         hid.
 *   webm  the audio is always synced to the video (Matroska never trims: its
 *         muxer shifts every stream together when one would go negative), plus
 *         the Opus `CodecDelay` compensation the pinned Matroska muxer needs:
 *         5.1.9 writes `CodecDelay` back into the output but does not offset
 *         the block timestamps by it (`matroskaenc.c`, the commented-out
 *         `ts_offset`), while its demuxer subtracts it on every read. Without
 *         the compensation an Opus track lands one CodecDelay early.
 *
 * FFmpeg computes the actual timestamp delta from the two input start times.
 * Nothing here carries an argument string, an input index, a time string or
 * any upstream text: the decision is converted into FIXED tokens by
 * `mergeSyncInputOptions()`, and the one number it may emit (the Opus
 * compensation) is formatted by the application from a validated integer.
 *
 * Deliberately target-generic and free of any split-plan type, so a later
 * two-input MP4 merge of another kind can reuse the MP4 policy unchanged.
 */

export const MERGE_SYNC_TARGETS = ["mp4", "webm"] as const;
export type MergeSyncTarget = (typeof MERGE_SYNC_TARGETS)[number];

/** Which input FFmpeg's `-isync` re-bases the other one against. */
export type MergeSyncReference = "video" | "audio";

export type MergeSyncDecision =
  | {
      readonly target: "mp4";
      readonly reference: MergeSyncReference;
    }
  | {
      readonly target: "webm";
      readonly reference: "video";
      /**
       * The positive `-itsoffset` applied to the AUDIO input, in integer
       * microseconds: exactly the Opus `CodecDelay` the output will carry and
       * its demuxer will subtract. `0` means no compensation (Vorbis, or Opus
       * with no CodecDelay).
       */
      readonly audioCodecDelayCompensationUs: number;
    };

/**
 * The bound on an input's container start time, exclusive, in microseconds:
 * 2^31 seconds.
 *
 * ffprobe prints `format.start_time` as `%f` of `int64 µs × 1e-6` in double
 * precision; below 2^31 s that product is within 0.48 µs of the exact value,
 * so the printed six-decimal text round-trips to the exact integer. It still
 * admits Unix-epoch-anchored timelines (a live-to-VOD `tfdt`) through 2038.
 */
export const MAX_ABS_MERGE_START_TIME_US = 2_147_483_648_000_000;

/**
 * The largest Opus `CodecDelay` the policy will compensate, in nanoseconds:
 * OpusHead's 16-bit pre-skip ceiling, 65535 samples at the fixed 48 kHz Opus
 * clock (65535 × 1e9 / 48000 = 1,365,312,500 ns exactly). Anything larger is
 * not an Opus delay and is refused rather than honoured.
 */
export const MAX_OPUS_CODEC_DELAY_NS = 1_365_312_500;

/** The facts the WebM decision needs about the audio half's single track. */
export type WebmAudioTrackTiming = {
  readonly codec: "opus" | "vorbis";
  /** The track's Matroska `CodecDelay`, nanoseconds; 0 when absent. */
  readonly codecDelayNs: number;
};

export class MergeSyncError extends Error {
  constructor() {
    super("merge synchronization facts are not usable");
    this.name = "MergeSyncError";
  }
}

function isStartTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) < MAX_ABS_MERGE_START_TIME_US
  );
}

/** `round(numerator / denominator)`, halves away from zero; non-negative operands. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/**
 * The compensation, in microseconds, for one Opus `CodecDelay`.
 *
 * Mirrors the pinned round trip exactly: the Matroska demuxer turns
 * `CodecDelay` into `initial_padding` samples at 48 kHz (`av_rescale_q`,
 * nearest), the muxer writes that back as nanoseconds, and the output demuxer
 * subtracts it again — so the compensation is the 48 kHz-quantized delay,
 * expressed in microseconds, nearest.
 */
export function opusCodecDelayCompensationUs(codecDelayNs: number): number {
  if (!Number.isSafeInteger(codecDelayNs) || codecDelayNs < 0 || codecDelayNs > MAX_OPUS_CODEC_DELAY_NS) {
    throw new MergeSyncError();
  }
  const samples = roundHalfUp(BigInt(codecDelayNs) * 48_000n, 1_000_000_000n);
  return Number(roundHalfUp(samples * 1_000_000n, 48_000n));
}

/**
 * The ONE place the synchronization state is chosen. Pure.
 *
 * The inputs are the two local container start times (integer µs, from the
 * Product's own probe of the validated local files) and, for WebM only, the
 * audio track's codec identity and CodecDelay (from the Product's own bounded
 * reader of the same local file). Duration, size, upstream metadata and any
 * caller value are not inputs, so none of them can steer the direction.
 */
export function decideMergeSync(facts: {
  readonly target: MergeSyncTarget;
  readonly videoStartUs: number;
  readonly audioStartUs: number;
  readonly webmAudio?: WebmAudioTrackTiming;
}): MergeSyncDecision {
  if (!isStartTime(facts.videoStartUs) || !isStartTime(facts.audioStartUs)) {
    throw new MergeSyncError();
  }
  if (facts.target === "mp4") {
    if (facts.webmAudio !== undefined) throw new MergeSyncError();
    return {
      target: "mp4",
      // The input that starts FIRST is the reference, so FFmpeg re-bases both
      // by the earliest start: nothing is pushed negative, so nothing is trimmed.
      reference: facts.audioStartUs < facts.videoStartUs ? "audio" : "video",
    };
  }
  if (facts.target === "webm") {
    const audio = facts.webmAudio;
    if (audio === undefined || !Number.isSafeInteger(audio.codecDelayNs) || audio.codecDelayNs < 0) {
      throw new MergeSyncError();
    }
    let compensation: number;
    if (audio.codec === "opus") {
      compensation = audio.codecDelayNs === 0 ? 0 : opusCodecDelayCompensationUs(audio.codecDelayNs);
    } else if (audio.codec === "vorbis") {
      // The pinned Matroska muxer writes CodecDelay for Opus only. A Vorbis
      // track declaring one is outside every evidenced shape: refuse it rather
      // than guess how its timestamps round-trip.
      if (audio.codecDelayNs !== 0) throw new MergeSyncError();
      compensation = 0;
    } else {
      throw new MergeSyncError();
    }
    return { target: "webm", reference: "video", audioCodecDelayCompensationUs: compensation };
  }
  throw new MergeSyncError();
}

/** Integer microseconds as FFmpeg duration text with exactly six decimals. */
export function formatMicrosecondsAsSeconds(us: number): string {
  if (!Number.isSafeInteger(us) || us < 0) throw new MergeSyncError();
  return `${Math.floor(us / 1_000_000)}.${String(us % 1_000_000).padStart(6, "0")}`;
}

/**
 * The FIXED input-option tokens for one decision: what precedes input 0 (the
 * video) and what precedes input 1 (the audio). Input numbering is fixed by
 * the caller's argv — 0 is video, 1 is audio — so each `-isync` reference
 * index is a literal here, never a value.
 *
 * Re-validates the decision, because a value that arrived by a cast or across
 * a boundary chooses FFmpeg arguments.
 */
export function mergeSyncInputOptions(decision: MergeSyncDecision): {
  readonly input0: readonly string[];
  readonly input1: readonly string[];
} {
  if (decision === null || typeof decision !== "object") throw new MergeSyncError();
  if (decision.target === "mp4") {
    if (decision.reference === "video") return { input0: [], input1: ["-isync", "0"] };
    if (decision.reference === "audio") return { input0: ["-isync", "1"], input1: [] };
    throw new MergeSyncError();
  }
  if (decision.target === "webm") {
    if (decision.reference !== "video") throw new MergeSyncError();
    const compensation = decision.audioCodecDelayCompensationUs;
    if (
      !Number.isSafeInteger(compensation) ||
      compensation < 0 ||
      compensation > opusCodecDelayCompensationUs(MAX_OPUS_CODEC_DELAY_NS)
    ) {
      throw new MergeSyncError();
    }
    return {
      input0: [],
      input1: [
        ...(compensation > 0 ? ["-itsoffset", formatMicrosecondsAsSeconds(compensation)] : []),
        "-isync",
        "0",
      ],
    };
  }
  throw new MergeSyncError();
}
