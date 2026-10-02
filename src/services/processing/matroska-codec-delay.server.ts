import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { AppError } from "@/lib/errors";
import { assertContainedRegularFile } from "@/services/processing/ffprobe.server";
import type { WebmAudioTrackTiming } from "@/services/processing/merge-sync";

/**
 * SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001: the purpose-specific,
 * bounded reader for ONE fact of ONE local WebM audio half — its single audio
 * track's codec identity and Matroska `CodecDelay`.
 *
 * ─── Why it exists ──────────────────────────────────────────────────────────
 *
 * The pinned FFmpeg 5.1.9 Matroska muxer writes an Opus track's `CodecDelay`
 * into the merged file without offsetting its block timestamps, while the
 * demuxer subtracts it on every read, so a timestamp-preserving merge must
 * compensate exactly that delay (see `merge-sync.ts`). The pinned ffprobe does
 * not expose it — it prints no `initial_padding`, and the demuxer emits
 * skip-samples side data only for `DiscardPadding` — and the delay must not be
 * guessed from a codec default, a duration or a first packet timestamp. The
 * file's own `CodecDelay` element is the authority.
 *
 * ─── What it is NOT ─────────────────────────────────────────────────────────
 *
 * Not an EBML or Matroska parser. It walks exactly one fixed path —
 * `EBML` header → `Segment` → `Tracks` → the ONE `TrackEntry` — over one
 * fixed-size prefix of the file, reads three values, and refuses everything it
 * does not recognize. It never descends into clusters, blocks, `Audio`,
 * `CodecPrivate` or any other master element, never follows a `SeekHead`, and
 * keeps no string: the codec id is compared byte-for-byte with two closed
 * constants and only the enum survives.
 *
 * Limits, all fixed: the prefix ceiling, the element-count ceiling, and a
 * nesting depth of three (Segment → Tracks → TrackEntry) by construction. Every
 * declared size is BigInt-checked against the bytes actually read before it is
 * used as an offset; no buffer is ever sized by a declared length. Unknown
 * sizes are accepted only where Matroska streaming writers emit them — the
 * Segment and a Cluster — and nowhere inside the track structure.
 */

/** Bytes of the file prefix examined. Fixed; the buffer is allocated once at this size. */
export const MATROSKA_READ_CEILING_BYTES = 1024 * 1024;

/** Elements visited, at every level combined, before the reader refuses. */
export const MATROSKA_MAX_ELEMENTS = 1024;

/** Master elements entered: Segment, Tracks, TrackEntry. Nothing deeper. */
export const MATROSKA_MAX_DEPTH = 3;

const ID = Object.freeze({
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675,
  CUES: 0x1c53bb6b,
  TAGS: 0x1254c367,
  CHAPTERS: 0x1043a770,
  ATTACHMENTS: 0x1941a469,
  VOID: 0xec,
  CRC32: 0xbf,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_DELAY: 0x56aa,
});

/** Segment children skipped by size, before or after Tracks. Anything else is refused. */
const SKIPPABLE_SEGMENT_CHILDREN: ReadonlySet<number> = new Set([
  ID.SEEK_HEAD,
  ID.INFO,
  ID.CUES,
  ID.TAGS,
  ID.CHAPTERS,
  ID.ATTACHMENTS,
  ID.VOID,
  ID.CRC32,
]);

/**
 * TrackEntry children that carry nothing this reader needs and are skipped by
 * size without being entered. The Matroska specification's TrackEntry
 * children, minus the three read below; an id outside this set is refused.
 */
const INERT_TRACK_ENTRY_CHILDREN: ReadonlySet<number> = new Set([
  0xd7, // TrackNumber
  0x73c5, // TrackUID
  0xb9, // FlagEnabled
  0x88, // FlagDefault
  0x55aa, // FlagForced
  0x55ab, // FlagHearingImpaired
  0x55ac, // FlagVisualImpaired
  0x55ad, // FlagTextDescriptions
  0x55ae, // FlagOriginal
  0x55af, // FlagCommentary
  0x9c, // FlagLacing
  0x6de7, // MinCache
  0x6df8, // MaxCache
  0x23e383, // DefaultDuration
  0x234e7a, // DefaultDecodedFieldDuration
  0x23314f, // TrackTimestampScale
  0x55ee, // MaxBlockAdditionID
  0x41e4, // BlockAdditionMapping
  0x536e, // Name
  0x22b59c, // Language
  0x22b59d, // LanguageBCP47
  0x63a2, // CodecPrivate
  0x258688, // CodecName
  0x7446, // AttachmentLink
  0xaa, // CodecDecodeAll
  0x6fab, // TrackOverlay
  0x56bb, // SeekPreRoll
  0x6624, // TrackTranslate
  0xe0, // Video
  0xe1, // Audio
  0xe2, // TrackOperation
  0x6d80, // ContentEncodings
  ID.VOID,
  ID.CRC32,
]);

/** The two Matroska audio codec ids a WebM split half may carry, as exact bytes. */
const CODEC_A_OPUS = Buffer.from("A_OPUS", "latin1");
const CODEC_A_VORBIS = Buffer.from("A_VORBIS", "latin1");
const MAX_CODEC_ID_BYTES = 32;

const TRACK_TYPE_AUDIO = 2n;

/** A refusal. Carries no detail by design: nothing parsed ever reaches an error. */
export class MatroskaReadError extends Error {
  constructor() {
    super("unsupported Matroska structure");
    this.name = "MatroskaReadError";
  }
}

/** A header that runs past the end of its container or of the bytes read. */
class MatroskaTruncatedError extends MatroskaReadError {}

type ElementHeader = {
  readonly id: number;
  /** Data length, or `null` for the EBML "unknown size" marker. */
  readonly size: bigint | null;
  readonly dataStart: number;
};

function leadingZeroBits(byte: number): number {
  return Math.clz32(byte) - 24;
}

function readHeader(bytes: Uint8Array, pos: number, end: number): ElementHeader {
  // Element ID: 1–4 bytes, marker bit retained in the value (Matroska convention).
  if (pos >= end) throw new MatroskaTruncatedError();
  const idFirst = bytes[pos];
  if (idFirst === 0) throw new MatroskaReadError();
  const idLength = leadingZeroBits(idFirst) + 1;
  if (idLength > 4) throw new MatroskaReadError();
  if (pos + idLength > end) throw new MatroskaTruncatedError();
  let id = 0;
  for (let i = 0; i < idLength; i += 1) id = id * 256 + bytes[pos + i];

  // Data size: 1–8 bytes, marker bit removed; all value bits set means "unknown".
  const sizePos = pos + idLength;
  if (sizePos >= end) throw new MatroskaTruncatedError();
  const sizeFirst = bytes[sizePos];
  if (sizeFirst === 0) throw new MatroskaReadError();
  const sizeLength = leadingZeroBits(sizeFirst) + 1;
  if (sizeLength > 8) throw new MatroskaReadError();
  if (sizePos + sizeLength > end) throw new MatroskaTruncatedError();
  let size = BigInt(sizeFirst & (0xff >> sizeLength));
  for (let i = 1; i < sizeLength; i += 1) size = (size << 8n) | BigInt(bytes[sizePos + i]);
  const unknown = size === (1n << BigInt(7 * sizeLength)) - 1n;
  return { id, size: unknown ? null : size, dataStart: sizePos + sizeLength };
}

/** The end offset of a KNOWN-size element, if it lies within `limit`; otherwise `null`. */
function knownEnd(header: ElementHeader, limit: number): number | null {
  if (header.size === null) return null;
  const end = BigInt(header.dataStart) + header.size;
  return end <= BigInt(limit) ? Number(end) : null;
}

function readUnsigned(bytes: Uint8Array, start: number, end: number): bigint {
  // An empty EBML unsigned integer is 0; more than 8 bytes is not an integer.
  if (end - start > 8) throw new MatroskaReadError();
  let value = 0n;
  for (let i = start; i < end; i += 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function sameBytes(bytes: Uint8Array, start: number, end: number, expected: Buffer): boolean {
  if (end - start !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[start + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Reads the single audio track's codec identity and CodecDelay from one WebM
 * prefix. Pure; throws `MatroskaReadError` for anything outside the one shape
 * it accepts.
 */
export function readWebmAudioTrackTiming(bytes: Uint8Array): WebmAudioTrackTiming {
  if (!(bytes instanceof Uint8Array) || bytes.length > MATROSKA_READ_CEILING_BYTES) {
    throw new MatroskaReadError();
  }
  let visited = 0;
  const visit = () => {
    visited += 1;
    if (visited > MATROSKA_MAX_ELEMENTS) throw new MatroskaReadError();
  };
  const length = bytes.length;

  // ── The EBML header: first, known size, entirely present; skipped. ───────
  const ebml = readHeader(bytes, 0, length);
  visit();
  if (ebml.id !== ID.EBML) throw new MatroskaReadError();
  const ebmlEnd = knownEnd(ebml, length);
  if (ebmlEnd === null) throw new MatroskaReadError();

  // ── The Segment (depth 1): known or unknown size; its end is clamped to
  //    the bytes actually read. ─────────────────────────────────────────────
  const segment = readHeader(bytes, ebmlEnd, length);
  visit();
  if (segment.id !== ID.SEGMENT) throw new MatroskaReadError();
  const segmentEnd = segment.size === null ? length : (knownEnd(segment, length) ?? length);

  let track: WebmAudioTrackTiming | null = null;
  let pos = segment.dataStart;
  while (pos < segmentEnd) {
    let child: ElementHeader;
    try {
      child = readHeader(bytes, pos, segmentEnd);
    } catch (err) {
      // A header cut off by the END OF THE BYTES READ, once the track has been
      // read, only means the window closed first: nothing after Tracks is
      // needed. Any other header failure — malformed, or truncated by a
      // declared Segment end, or before the track — is a refusal.
      if (err instanceof MatroskaTruncatedError && track !== null && segmentEnd === length) break;
      throw err;
    }
    visit();
    if (child.id === ID.CLUSTER) break;
    if (child.id === ID.TRACKS) {
      // Exactly one Tracks element, entirely within the window.
      if (track !== null) throw new MatroskaReadError();
      const tracksEnd = knownEnd(child, segmentEnd);
      if (tracksEnd === null) throw new MatroskaReadError();
      track = readTracks(bytes, child.dataStart, tracksEnd, visit);
      pos = tracksEnd;
      continue;
    }
    if (!SKIPPABLE_SEGMENT_CHILDREN.has(child.id)) throw new MatroskaReadError();
    const next = knownEnd(child, segmentEnd);
    if (next === null) {
      // Extends past the window (or has an unknown size): fine once the track
      // is read, since nothing after it is needed; fatal before.
      if (track !== null) break;
      throw new MatroskaReadError();
    }
    pos = next;
  }
  if (track === null) throw new MatroskaReadError();
  return track;
}

/** Tracks (depth 2): exactly one TrackEntry; Void and CRC-32 tolerated. */
function readTracks(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: () => void,
): WebmAudioTrackTiming {
  let entry: WebmAudioTrackTiming | null = null;
  let pos = start;
  while (pos < end) {
    const child = readHeader(bytes, pos, end);
    visit();
    const childEnd = knownEnd(child, end);
    if (childEnd === null) throw new MatroskaReadError();
    if (child.id === ID.TRACK_ENTRY) {
      if (entry !== null) throw new MatroskaReadError();
      entry = readTrackEntry(bytes, child.dataStart, childEnd, visit);
    } else if (child.id !== ID.VOID && child.id !== ID.CRC32) {
      throw new MatroskaReadError();
    }
    pos = childEnd;
  }
  if (entry === null) throw new MatroskaReadError();
  return entry;
}

/** TrackEntry (depth 3): reads TrackType, CodecID and CodecDelay; skips the inert rest. */
function readTrackEntry(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: () => void,
): WebmAudioTrackTiming {
  let trackType: bigint | null = null;
  let codec: "opus" | "vorbis" | null = null;
  let codecSeen = false;
  let codecDelay: bigint | null = null;
  let pos = start;
  while (pos < end) {
    const child = readHeader(bytes, pos, end);
    visit();
    const childEnd = knownEnd(child, end);
    if (childEnd === null) throw new MatroskaReadError();
    switch (child.id) {
      case ID.TRACK_TYPE:
        if (trackType !== null) throw new MatroskaReadError();
        if (childEnd - child.dataStart < 1) throw new MatroskaReadError();
        trackType = readUnsigned(bytes, child.dataStart, childEnd);
        break;
      case ID.CODEC_ID:
        if (codecSeen) throw new MatroskaReadError();
        codecSeen = true;
        if (childEnd - child.dataStart > MAX_CODEC_ID_BYTES) throw new MatroskaReadError();
        if (sameBytes(bytes, child.dataStart, childEnd, CODEC_A_OPUS)) codec = "opus";
        else if (sameBytes(bytes, child.dataStart, childEnd, CODEC_A_VORBIS)) codec = "vorbis";
        else throw new MatroskaReadError();
        break;
      case ID.CODEC_DELAY:
        if (codecDelay !== null) throw new MatroskaReadError();
        codecDelay = readUnsigned(bytes, child.dataStart, childEnd);
        break;
      default:
        if (!INERT_TRACK_ENTRY_CHILDREN.has(child.id)) throw new MatroskaReadError();
    }
    pos = childEnd;
  }
  if (trackType !== TRACK_TYPE_AUDIO || codec === null) throw new MatroskaReadError();
  const delay = codecDelay ?? 0n;
  if (delay > BigInt(Number.MAX_SAFE_INTEGER)) throw new MatroskaReadError();
  return { codec, codecDelayNs: Number(delay) };
}

/**
 * Reads the timing facts of one LOCAL WebM audio half.
 *
 * The file must already be — and is checked again here to be — a regular file
 * physically inside the work directory; it is opened without following a
 * symlink, `fstat`-checked, and at most `MATROSKA_READ_CEILING_BYTES` are read
 * into a buffer of exactly that size. Every refusal is the canonical
 * `PROCESSING_FAILED`, with no parser detail.
 */
export async function readLocalWebmAudioTrackTiming(opts: {
  workDir: string;
  inputPath: string;
  signal?: AbortSignal;
}): Promise<WebmAudioTrackTiming> {
  if (opts.signal?.aborted) {
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  }
  const path = await assertContainedRegularFile(opts.workDir, opts.inputPath);
  const buffer = Buffer.alloc(MATROSKA_READ_CEILING_BYTES);
  let filled = 0;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new MatroskaReadError();
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return readWebmAudioTrackTiming(buffer.subarray(0, filled));
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }
}
