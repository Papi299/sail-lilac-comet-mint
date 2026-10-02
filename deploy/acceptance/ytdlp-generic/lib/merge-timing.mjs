// The split-merge TIMING oracle (SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001).
//
// Shared by the SPLIT-06, DASH-01 and SYNC-01 children. It answers one question
// about a two-input stream-copy merge, from PACKET timestamps rather than from
// `format.start_time`:
//
//   Is the relative A/V timing of the two input files the relative A/V timing
//   of the merged file — with every packet carried, none hidden that the
//   source presented, and none presented that the source hid?
//
// ── Method ─────────────────────────────────────────────────────────────────
//
// The harness's OWN ffprobe lists every packet of each input and of the output
// with its timestamps, its discard flag and the SHA-256 of its payload. Input
// and output packets of each stream are paired by payload identity; the
// difference between an output packet's PTS and its input packet's PTS is that
// stream's SHIFT, which must be one constant for the whole stream. The merge
// preserved the relative timing exactly when the two shifts are equal — within
// a tolerance derived from the time bases involved, never a wall-clock guess:
//
//   one tick of the output video time base
//   + one tick of the output audio time base
//   + (MP4) one tick of the output's movie timescale, because the MP4 muxer
//     writes each track's start delay as an edit-list empty edit rounded DOWN
//     to that timescale.
//
// All arithmetic is exact (BigInt rationals); only the evidence summary is
// rounded, to integer microseconds.
//
// Import-free, so the parent and the self-tests can load it on any Node.

/** The packet-level ffprobe entries the oracle reads. */
export const MERGE_TIMING_SHOW_ENTRIES =
  "stream=index,codec_type,codec_name,time_base,extradata_hash:packet=stream_index,pts,dts,duration,flags,data_hash";

/** The harness's packet-timeline ffprobe argv for one local file. */
export function mergeTimingProbeArgs(demuxer, path) {
  if (demuxer !== "mov" && demuxer !== "matroska") throw new Error(`unsupported demuxer ${String(demuxer)}`);
  return [
    "-v", "error",
    "-protocol_whitelist", "file",
    "-f", demuxer,
    "-print_format", "json",
    "-show_data_hash", "SHA256",
    "-show_entries", MERGE_TIMING_SHOW_ENTRIES,
    "-i", path,
  ];
}

// ── Exact rationals ────────────────────────────────────────────────────────

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rational(numerator, denominator = 1n) {
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (d === 0n) throw new Error("zero denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return Object.freeze({ n: n / g, d: d / g });
}

export const ratAdd = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const ratSub = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const ratCmp = (a, b) => {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};
export const ratAbs = (a) => rational(a.n < 0n ? -a.n : a.n, a.d);
export const ratMin = (a, b) => (ratCmp(a, b) <= 0 ? a : b);
export const ratEq = (a, b) => a.n === b.n && a.d === b.d;

/** Integer microseconds, halves away from zero. */
export function ratToMicros(a) {
  if (a === null) return null;
  const scaled = a.n * 1_000_000n;
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const rounded = (2n * magnitude + a.d) / (2n * a.d);
  const value = Number(negative ? -rounded : rounded);
  return value === 0 ? 0 : value;
}

function parseTimeBase(text) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(text));
  if (match === null) throw new Error(`unparseable time base ${String(text)}`);
  return rational(BigInt(match[1]), BigInt(match[2]));
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) ? BigInt(value) : null;
}

// ── Packet timelines ───────────────────────────────────────────────────────

/**
 * One file's packet timeline, by stream kind. Refuses any document that does
 * not carry at most one video and at most one audio stream, each with a time
 * base and per-packet payload hashes.
 */
export function parsePacketTimeline(stdout) {
  const doc = typeof stdout === "string" ? JSON.parse(stdout) : stdout;
  const streams = Array.isArray(doc?.streams) ? doc.streams : [];
  const packets = Array.isArray(doc?.packets) ? doc.packets : [];
  const out = { video: null, audio: null, streamCount: streams.length };
  for (const stream of streams) {
    const kind = stream?.codec_type;
    if (kind !== "video" && kind !== "audio") throw new Error(`unexpected stream kind ${String(kind)}`);
    if (out[kind] !== null) throw new Error(`more than one ${kind} stream`);
    const tb = parseTimeBase(stream.time_base);
    const own = packets
      .filter((packet) => packet?.stream_index === stream.index)
      .map((packet) => {
        if (typeof packet.data_hash !== "string" || !packet.data_hash.startsWith("SHA256:")) {
          throw new Error("a packet carries no payload hash");
        }
        return Object.freeze({
          pts: integerOrNull(packet.pts),
          dts: integerOrNull(packet.dts),
          duration: integerOrNull(packet.duration) ?? 0n,
          discard: typeof packet.flags === "string" && packet.flags.includes("D"),
          hash: packet.data_hash,
        });
      });
    out[kind] = Object.freeze({
      timeBase: tb,
      codecName: typeof stream.codec_name === "string" ? stream.codec_name : null,
      extradataHash: typeof stream.extradata_hash === "string" ? stream.extradata_hash : null,
      packets: Object.freeze(own),
    });
  }
  return out;
}

const at = (ticks, tb) => rational(ticks * tb.n, tb.d);

/** The earliest PTS of a packet the demuxer PRESENTS (not discard-flagged), or null. */
export function firstPresented(stream) {
  let best = null;
  for (const packet of stream.packets) {
    if (packet.pts === null || packet.discard) continue;
    const t = at(packet.pts, stream.timeBase);
    best = best === null ? t : ratMin(best, t);
  }
  return best;
}

/** The latest end (PTS + duration) of a presented packet, or null. */
export function lastPresentedEnd(stream) {
  let best = null;
  for (const packet of stream.packets) {
    if (packet.pts === null || packet.discard) continue;
    const t = at(packet.pts + packet.duration, stream.timeBase);
    best = best === null || ratCmp(t, best) > 0 ? t : best;
  }
  return best;
}

/**
 * Pairs one stream's input and output packets by payload identity.
 * `offset` is the index shift (0 = every packet in place); `null` = no pairing.
 */
export function alignByPayload(input, output) {
  const a = input.packets.map((p) => p.hash);
  const b = output.packets.map((p) => p.hash);
  if (a.length === b.length && a.every((hash, i) => hash === b[i])) {
    return { offset: 0, pairs: a.map((_, i) => [input.packets[i], output.packets[i]]) };
  }
  let best = null;
  for (let k = -64; k <= 64; k += 1) {
    const pairs = [];
    let ok = true;
    for (let i = 0; i < b.length; i += 1) {
      const j = i + k;
      if (j < 0 || j >= a.length) continue;
      if (a[j] !== b[i]) {
        ok = false;
        break;
      }
      pairs.push([input.packets[j], output.packets[i]]);
    }
    if (ok && pairs.length > 0 && (best === null || pairs.length > best.pairs.length)) best = { offset: k, pairs };
  }
  return best;
}

/** One stream's measured shift from input to output. */
export function streamShift(input, output) {
  const aligned = alignByPayload(input, output);
  if (aligned === null) {
    return { aligned: false, payloadIdentical: false, constant: false, shift: null, discardIn: null, discardOut: null };
  }
  let shift = null;
  let constant = true;
  for (const [i, o] of aligned.pairs) {
    if (i.pts === null || o.pts === null) {
      constant = false;
      continue;
    }
    const d = ratSub(at(o.pts, output.timeBase), at(i.pts, input.timeBase));
    if (shift === null) shift = d;
    else if (!ratEq(shift, d)) constant = false;
  }
  return {
    aligned: true,
    payloadIdentical:
      aligned.offset === 0 && input.packets.length === output.packets.length && aligned.pairs.length === input.packets.length,
    constant,
    shift,
    discardIn: input.packets.filter((p) => p.discard).length,
    discardOut: output.packets.filter((p) => p.discard).length,
  };
}

/**
 * The verdict for one merge. `videoInput`/`audioInput`/`output` are parsed
 * timelines; `movieTimescale` is the MP4 output's `mvhd` timescale (null for
 * WebM). Every boolean is computed exactly; the `*Us` fields are the rounded
 * evidence summary.
 */
export function evaluateMergeTiming({ videoInput, audioInput, output, movieTimescale = null }) {
  const vIn = videoInput?.video;
  const aIn = audioInput?.audio;
  const vOut = output?.video;
  const aOut = output?.audio;
  if (!vIn || !aIn || !vOut || !aOut) {
    return Object.freeze({ measurable: false, reason: "an input or the output lacks the expected stream" });
  }
  const sourceRelative = ratSub(firstPresented(aIn), firstPresented(vIn));
  const outputRelative = ratSub(firstPresented(aOut), firstPresented(vOut));
  const video = streamShift(vIn, vOut);
  const audio = streamShift(aIn, aOut);
  let tolerance = ratAdd(rational(vOut.timeBase.n, vOut.timeBase.d), rational(aOut.timeBase.n, aOut.timeBase.d));
  if (movieTimescale !== null) tolerance = ratAdd(tolerance, rational(1n, BigInt(movieTimescale)));

  const shiftDelta = video.shift !== null && audio.shift !== null ? ratSub(audio.shift, video.shift) : null;
  const relativeDelta = ratSub(outputRelative, sourceRelative);
  const within = (value) => value !== null && ratCmp(ratAbs(value), tolerance) <= 0;

  const span = (stream) => ratSub(lastPresentedEnd(stream), firstPresented(stream));
  const earliestOut = ratMin(firstPresented(vOut), firstPresented(aOut));

  return Object.freeze({
    measurable: true,
    sourceRelativeUs: ratToMicros(sourceRelative),
    outputRelativeUs: ratToMicros(outputRelative),
    relativeDeltaUs: ratToMicros(relativeDelta),
    videoShiftUs: ratToMicros(video.shift),
    audioShiftUs: ratToMicros(audio.shift),
    packetShiftDeltaUs: ratToMicros(shiftDelta),
    toleranceUs: ratToMicros(tolerance),
    outputEarliestPresentedUs: ratToMicros(earliestOut),
    sourceVideoFirstPresentedUs: ratToMicros(firstPresented(vIn)),
    sourceAudioFirstPresentedUs: ratToMicros(firstPresented(aIn)),
    outputVideoFirstPresentedUs: ratToMicros(firstPresented(vOut)),
    outputAudioFirstPresentedUs: ratToMicros(firstPresented(aOut)),
    packets: {
      video: { input: vIn.packets.length, output: vOut.packets.length, discardIn: video.discardIn, discardOut: video.discardOut },
      audio: { input: aIn.packets.length, output: aOut.packets.length, discardIn: audio.discardIn, discardOut: audio.discardOut },
    },
    // ── verdicts ──
    payloadIdentical: video.payloadIdentical && audio.payloadIdentical,
    shiftsConstant: video.constant && audio.constant,
    relativeTimingPreserved: within(shiftDelta) && within(relativeDelta),
    noMediaHiddenOrUnhidden:
      video.payloadIdentical && audio.payloadIdentical &&
      video.discardIn === video.discardOut && audio.discardIn === audio.discardOut,
    noLeadingGap: ratCmp(earliestOut, tolerance) <= 0,
    streamSpansPreserved: within(ratSub(span(vOut), span(vIn))) && within(ratSub(span(aOut), span(aIn))),
    codecParametersPreserved:
      vIn.codecName === vOut.codecName && vIn.extradataHash === vOut.extradataHash &&
      aIn.codecName === aOut.codecName && aIn.extradataHash === aOut.extradataHash,
  });
}

/**
 * The `mvhd` timescale of an MP4 file's bytes, or null. Reads top-level boxes
 * only, then the `moov`'s children; bounded by the buffer it is given.
 */
export function mp4MovieTimescale(bytes) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const boxes = (start, end) => {
    const out = [];
    let pos = start;
    for (let n = 0; pos + 8 <= end && n < 4096; n += 1) {
      let size = view.readUInt32BE(pos);
      const type = view.toString("latin1", pos + 4, pos + 8);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = Number(view.readBigUInt64BE(pos + 8));
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header || pos + size > end) break;
      out.push({ type, dataStart: pos + header, end: pos + size });
      pos += size;
    }
    return out;
  };
  const moov = boxes(0, view.length).find((box) => box.type === "moov");
  if (!moov) return null;
  const mvhd = boxes(moov.dataStart, moov.end).find((box) => box.type === "mvhd");
  if (!mvhd) return null;
  const version = view[mvhd.dataStart];
  const offset = mvhd.dataStart + (version === 1 ? 20 : 12);
  if (offset + 4 > mvhd.end) return null;
  const timescale = view.readUInt32BE(offset);
  return timescale > 0 ? timescale : null;
}

/** Runs the harness ffprobe over one file and parses its packet timeline. */
export async function probePacketTimeline(runTool, ffprobePath, demuxer, path) {
  const result = await runTool(ffprobePath, mergeTimingProbeArgs(demuxer, path), { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`packet timeline probe failed (exit ${result.code})`);
  return parsePacketTimeline(result.stdout);
}

// ── The merge argv's timestamp policy, as a CLOSED description ─────────────

/** Timestamp flags the corrected merge must never carry. */
export const FORBIDDEN_MERGE_TIMESTAMP_FLAGS = Object.freeze([
  "-copyts",
  "-start_at_zero",
  "-avoid_negative_ts",
  "-output_ts_offset",
  "-shortest",
  "-ss",
  "-t",
  "-to",
]);

const isSixDecimalSeconds = (text) => /^[0-9]+\.[0-9]{6}$/.test(text);

/**
 * Describes ONE FFmpeg merge argv's synchronization tokens without retaining
 * anything else: the input options before each of the two inputs (between the
 * previous input's `-i <path>` — or `-v error` — and that input's own
 * `-protocol_whitelist`), and which forbidden timestamp flags appear anywhere.
 * An `-itsoffset` value survives only in the application's exact
 * six-decimal form; anything else is recorded as `<other>`.
 */
export function describeMergeSync(args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const inputs = argv.flatMap((arg, i) => (arg === "-i" ? [i] : []));
  const sanitize = (tokens) =>
    tokens.map((token, i) =>
      tokens[i - 1] === "-itsoffset" ? (isSixDecimalSeconds(token) ? token : "<other>") : token,
    );
  const optionsBefore = (from, inputIndex) => {
    if (inputIndex === undefined) return null;
    const whitelist = argv.indexOf("-protocol_whitelist", from);
    if (whitelist === -1 || whitelist > inputIndex) return null;
    return sanitize(argv.slice(from, whitelist));
  };
  const head = argv.indexOf("error") === 3 && argv[2] === "-v" ? 4 : 0;
  return Object.freeze({
    inputCount: inputs.length,
    input0: optionsBefore(head, inputs[0]),
    input1: inputs.length >= 2 ? optionsBefore(inputs[0] + 2, inputs[1]) : null,
    forbiddenFlags: FORBIDDEN_MERGE_TIMESTAMP_FLAGS.filter((flag) => argv.includes(flag)),
  });
}

/** `round(n / d)`, halves away from zero, non-negative BigInts. */
const roundHalfUp = (n, d) => (2n * n + d) / (2n * d);

/** The Opus CodecDelay compensation, µs, through the 48 kHz clock. Harness-side, independent of the product. */
export function opusCompensationMicros(codecDelayNs) {
  if (!Number.isSafeInteger(codecDelayNs) || codecDelayNs < 0) throw new Error("bad CodecDelay");
  const samples = roundHalfUp(BigInt(codecDelayNs) * 48_000n, 1_000_000_000n);
  return Number(roundHalfUp(samples * 1_000_000n, 48_000n));
}

export function formatSixDecimalSeconds(us) {
  return `${Math.floor(us / 1_000_000)}.${String(us % 1_000_000).padStart(6, "0")}`;
}

/**
 * The harness's OWN reading of an FFmpeg-written WebM audio FIXTURE's Opus
 * CodecDelay: the `56 AA` element that follows the `A_OPUS` codec id. A
 * deliberately naive scan of a file the harness generated itself — not the
 * product's bounded reader, and never run on untrusted media. 0 when the
 * fixture is not Opus or declares no delay.
 */
export function fixtureOpusCodecDelayNs(bytes) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const window = view.subarray(0, Math.min(view.length, 64 * 1024));
  const codec = window.indexOf(Buffer.from("A_OPUS", "latin1"));
  if (codec === -1) return 0;
  const element = window.indexOf(Buffer.from([0x56, 0xaa]), codec);
  if (element === -1 || element - codec > 128) return 0;
  const sizeByte = window[element + 2];
  const length = Math.clz32(sizeByte) - 24 + 1;
  if (length !== 1) throw new Error("unexpected CodecDelay size encoding in the fixture");
  const size = sizeByte & 0x7f;
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + window[element + 3 + i];
  return value;
}

/**
 * The closed synchronization tokens a CORRECT merge of these inputs must carry,
 * decided by the harness BEFORE the job from its own measurements:
 *
 *   mp4   the input that is presented first is the `-isync` reference (the
 *         video on a tie), so FFmpeg re-bases both by the earliest start;
 *   webm  the audio is synced to the video, preceded by the Opus CodecDelay
 *         compensation when the audio fixture declares one.
 */
export function expectedMergeSync({ target, videoInput, audioInput, opusCodecDelayNs = 0 }) {
  if (target === "mp4") {
    const audioFirst = ratCmp(firstPresented(audioInput.audio), firstPresented(videoInput.video)) < 0;
    return audioFirst ? { input0: ["-isync", "1"], input1: [] } : { input0: [], input1: ["-isync", "0"] };
  }
  if (target === "webm") {
    const us = opusCodecDelayNs > 0 ? opusCompensationMicros(opusCodecDelayNs) : 0;
    return { input0: [], input1: [...(us > 0 ? ["-itsoffset", formatSixDecimalSeconds(us)] : []), "-isync", "0"] };
  }
  throw new Error(`unknown target ${String(target)}`);
}

/** Whether an observed `describeMergeSync` result is exactly the expected closed policy. */
export function mergeSyncMatches(observed, expected) {
  return (
    observed !== null && typeof observed === "object" &&
    observed.inputCount === 2 &&
    observed.forbiddenFlags.length === 0 &&
    JSON.stringify(observed.input0) === JSON.stringify(expected.input0) &&
    JSON.stringify(observed.input1) === JSON.stringify(expected.input1)
  );
}

/**
 * A pair's SOURCE timing, measured before any job: the audio's first presented
 * PTS minus the video's, and whether that offset exceeds what rounding alone
 * could produce (one tick of each input time base plus one millisecond) — i.e.
 * whether this pair can tell a timestamp-preserving merge from one that zeroes
 * each input independently.
 */
export function pairSourceTiming(videoInput, audioInput) {
  const v = videoInput?.video;
  const a = audioInput?.audio;
  if (!v || !a) return Object.freeze({ measurable: false, relativeUs: null, discriminating: false });
  const relative = ratSub(firstPresented(a), firstPresented(v));
  const floor = ratAdd(ratAdd(rational(v.timeBase.n, v.timeBase.d), rational(a.timeBase.n, a.timeBase.d)), rational(1n, 1000n));
  const start = ratMin(firstPresented(v), firstPresented(a));
  const ends = [lastPresentedEnd(v), lastPresentedEnd(a)];
  const end = ratCmp(ends[0], ends[1]) >= 0 ? ends[0] : ends[1];
  return Object.freeze({
    measurable: true,
    relativeUs: ratToMicros(relative),
    videoFirstPresentedUs: ratToMicros(firstPresented(v)),
    audioFirstPresentedUs: ratToMicros(firstPresented(a)),
    // The span a timing-preserving merge of this pair presents: earliest
    // presented start to latest presented end, across both streams.
    spanUs: ratToMicros(ratSub(end, start)),
    discriminating: ratCmp(ratAbs(relative), floor) > 0,
  });
}
