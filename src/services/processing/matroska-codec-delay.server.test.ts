import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import {
  MATROSKA_MAX_ELEMENTS,
  MATROSKA_READ_CEILING_BYTES,
  MatroskaReadError,
  readLocalWebmAudioTrackTiming,
  readWebmAudioTrackTiming,
} from "./matroska-codec-delay.server.ts";

// SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001 — the bounded,
// purpose-specific WebM audio CodecDelay reader.

/** A real FFmpeg 5.1.9 WebM header prefix (everything before the first Cluster's data). See testdata/README.md. */
function pinnedHeader(name: "opus" | "vorbis"): Promise<Buffer> {
  return readFile(join(import.meta.dirname, "testdata", `pinned-matroska-header-${name}-audio.bin`));
}

// ── A test-only EBML writer for the refusal cases ──────────────────────────

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

function sizeBytes(size: number, length?: number): number[] {
  let n = length ?? 1;
  while (length === undefined && size >= 2 ** (7 * n) - 1) n += 1;
  const out: number[] = [];
  let v = size;
  for (let i = 0; i < n; i += 1) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - n);
  return out;
}

const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function el(id: number, ...children: (number[] | Buffer)[]): number[] {
  const payload = children.flatMap((c) => [...c]);
  return [...idBytes(id), ...sizeBytes(payload.length), ...payload];
}
function elUnknown(id: number, ...children: number[][]): number[] {
  return [...idBytes(id), ...UNKNOWN, ...children.flat()];
}
const uint = (id: number, value: number, bytes = 1) => {
  const out: number[] = [];
  let v = value;
  for (let i = 0; i < bytes; i += 1) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return el(id, out);
};
const str = (id: number, text: string) => el(id, [...Buffer.from(text, "latin1")]);

const EBML_HEADER = el(0x1a45dfa3, str(0x4282, "webm"));
const SEEK_HEAD = el(0x114d9b74, el(0x4dbb, uint(0x53ac, 1)));
const INFO = el(0x1549a966, uint(0x2ad7b1, 1_000_000, 3));
const CLUSTER_HEAD = [...idBytes(0x1f43b675), ...UNKNOWN];
const TRACK_NUMBER = uint(0xd7, 1);
const OPUS = str(0x86, "A_OPUS");
const AUDIO_TYPE = uint(0x83, 2);
const DELAY = uint(0x56aa, 6_500_000, 3);

function file(trackEntryChildren: number[][], extra: { beforeTracks?: number[][]; afterTracks?: number[][] } = {}) {
  return Uint8Array.from([
    ...EBML_HEADER,
    ...elUnknown(
      0x18538067,
      SEEK_HEAD,
      INFO,
      ...(extra.beforeTracks ?? []),
      el(0x1654ae6b, el(0xae, ...trackEntryChildren)),
      ...(extra.afterTracks ?? []),
      CLUSTER_HEAD,
    ),
  ]);
}

const refuses = (bytes: Uint8Array) =>
  assert.throws(() => readWebmAudioTrackTiming(bytes), (err: unknown) => err instanceof MatroskaReadError);

describe("WebM audio CodecDelay reader — accepted shapes", () => {
  it("reads the real FFmpeg-written Opus header: A_OPUS, CodecDelay 6.5 ms", async () => {
    assert.deepEqual(readWebmAudioTrackTiming(await pinnedHeader("opus")), { codec: "opus", codecDelayNs: 6_500_000 });
  });

  it("reads the real FFmpeg-written Vorbis header: A_VORBIS, no CodecDelay", async () => {
    // 3 KiB of CodecPrivate is skipped by size, never entered.
    assert.deepEqual(readWebmAudioTrackTiming(await pinnedHeader("vorbis")), { codec: "vorbis", codecDelayNs: 0 });
  });

  it("treats an absent or empty CodecDelay as zero", () => {
    assert.deepEqual(readWebmAudioTrackTiming(file([TRACK_NUMBER, OPUS, AUDIO_TYPE])), { codec: "opus", codecDelayNs: 0 });
    assert.deepEqual(readWebmAudioTrackTiming(file([OPUS, el(0x56aa), AUDIO_TYPE])), { codec: "opus", codecDelayNs: 0 });
  });

  it("accepts a known-size Segment, Void/CRC-32 padding, and inert track children", () => {
    const entry = [TRACK_NUMBER, el(0xec, [0, 0]), OPUS, DELAY, uint(0x56bb, 80_000_000, 4), AUDIO_TYPE, el(0xe1, uint(0xb5, 1))];
    const tracks = el(0x1654ae6b, el(0xbf, [1, 2, 3, 4]), el(0xae, ...entry), el(0xec, [0]));
    const segment = el(0x18538067, SEEK_HEAD, INFO, tracks, CLUSTER_HEAD);
    assert.deepEqual(readWebmAudioTrackTiming(Uint8Array.from([...EBML_HEADER, ...segment])), {
      codec: "opus",
      codecDelayNs: 6_500_000,
    });
  });

  it("stops at the first Cluster, and at the end of the read window once the track is read", async () => {
    const real = await pinnedHeader("opus");
    // Cut the prefix inside the Tags element header that follows Tracks: the
    // window closed after the track, which is all the reader needs. Offsets are
    // anchored on the codec id INSIDE the TrackEntry, because the SeekHead's
    // SeekID payloads repeat the Tracks and Tags ids earlier in the file.
    const codecAt = real.indexOf(Buffer.from("A_OPUS", "latin1"));
    const tagsAt = real.indexOf(Buffer.from([0x12, 0x54, 0xc3, 0x67]), codecAt);
    assert.ok(codecAt > 0 && tagsAt > codecAt);
    assert.deepEqual(readWebmAudioTrackTiming(real.subarray(0, tagsAt + 2)), { codec: "opus", codecDelayNs: 6_500_000 });
    assert.deepEqual(readWebmAudioTrackTiming(real.subarray(0, tagsAt)), { codec: "opus", codecDelayNs: 6_500_000 });
  });
});

describe("WebM audio CodecDelay reader — refusals", () => {
  it("refuses duplicate relevant elements", () => {
    refuses(file([OPUS, DELAY, DELAY, AUDIO_TYPE]));
    refuses(file([OPUS, OPUS, DELAY, AUDIO_TYPE]));
    refuses(file([OPUS, DELAY, AUDIO_TYPE, AUDIO_TYPE]));
    refuses(file([OPUS, DELAY, AUDIO_TYPE], { afterTracks: [el(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE))] }));
    // Two TrackEntries in one Tracks element.
    const twoEntries = Uint8Array.from([
      ...EBML_HEADER,
      ...elUnknown(0x18538067, el(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE), el(0xae, OPUS, AUDIO_TYPE)), CLUSTER_HEAD),
    ]);
    refuses(twoEntries);
  });

  it("refuses a codec id outside the two closed constants, exactly compared", () => {
    for (const codec of ["A_AAC", "A_OPUS\0", "a_opus", "A_OPUS ", "A_VORBISX", "V_VP9", "", "A_OPUS".repeat(6)]) {
      refuses(file([str(0x86, codec), DELAY, AUDIO_TYPE]));
    }
  });

  it("refuses a missing codec id or a non-audio / missing track type", () => {
    refuses(file([DELAY, AUDIO_TYPE]));
    refuses(file([OPUS, DELAY]));
    refuses(file([OPUS, DELAY, uint(0x83, 1)]));
    refuses(file([OPUS, DELAY, el(0x83)]));
  });

  it("refuses an over-long or out-of-range CodecDelay integer", () => {
    refuses(file([OPUS, el(0x56aa, [1, 0, 0, 0, 0, 0, 0, 0, 0]), AUDIO_TYPE])); // 9 bytes
    refuses(file([OPUS, el(0x56aa, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), AUDIO_TYPE])); // > 2^53
  });

  it("refuses unknown structure at every level", () => {
    refuses(file([OPUS, DELAY, AUDIO_TYPE, uint(0x7fff, 1, 1)])); // unknown TrackEntry child
    refuses(file([OPUS, DELAY, AUDIO_TYPE], { beforeTracks: [el(0x1f43b676, [0])] })); // unknown Segment child
    const tracksWithForeignChild = Uint8Array.from([
      ...EBML_HEADER,
      ...elUnknown(0x18538067, el(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE), uint(0xd7, 1)), CLUSTER_HEAD),
    ]);
    refuses(tracksWithForeignChild);
  });

  it("refuses a Cluster before Tracks, and a file with no Tracks at all", () => {
    refuses(Uint8Array.from([...EBML_HEADER, ...elUnknown(0x18538067, SEEK_HEAD, CLUSTER_HEAD, el(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE)))]));
    refuses(Uint8Array.from([...EBML_HEADER, ...elUnknown(0x18538067, SEEK_HEAD, INFO)]));
  });

  it("refuses a file that does not open with an EBML header and a Segment", () => {
    const good = file([OPUS, DELAY, AUDIO_TYPE]);
    refuses(good.subarray(EBML_HEADER.length)); // Segment first
    refuses(Uint8Array.from([...EBML_HEADER, ...el(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE))])); // no Segment
    refuses(Uint8Array.from([...elUnknown(0x1a45dfa3), ...good.subarray(EBML_HEADER.length)])); // unknown-size EBML header
    refuses(new Uint8Array(0));
  });

  it("refuses malformed element ids and sizes", () => {
    refuses(Uint8Array.from([0x00, 0x81, 0x00])); // id with no length marker
    refuses(Uint8Array.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x81, 0x00])); // 5-byte id
    refuses(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])); // size with no length marker
    // A TrackEntry child whose size runs past the TrackEntry.
    refuses(file([OPUS, [0x56, 0xaa, 0x85, 0x00], AUDIO_TYPE]));
  });

  it("refuses unknown sizes inside the track structure", () => {
    refuses(Uint8Array.from([...EBML_HEADER, ...elUnknown(0x18538067, elUnknown(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE)))]));
    refuses(Uint8Array.from([...EBML_HEADER, ...elUnknown(0x18538067, el(0x1654ae6b, elUnknown(0xae, OPUS, AUDIO_TYPE)))]));
  });

  it("refuses a declared size beyond the bytes read before the track, without allocating it", () => {
    // A SeekHead claiming 2^56 - 2 bytes: the reader cannot reach Tracks, and it
    // never sizes a buffer from the claim.
    const huge = [...idBytes(0x114d9b74), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe];
    refuses(Uint8Array.from([...EBML_HEADER, ...elUnknown(0x18538067, huge, el(0x1654ae6b, el(0xae, OPUS, AUDIO_TYPE)))]));
    // Tracks itself running past the bytes read.
    const real = file([OPUS, DELAY, AUDIO_TYPE]);
    const tracksAt = Buffer.from(real).indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b]));
    refuses(real.subarray(0, tracksAt + 12));
  });

  it("refuses a file truncated inside the track structure", async () => {
    const real = await pinnedHeader("opus");
    const delayAt = real.indexOf(Buffer.from([0x56, 0xaa]), real.indexOf(Buffer.from("A_OPUS", "latin1")));
    assert.ok(delayAt > 0);
    refuses(real.subarray(0, delayAt + 3));
  });

  it("refuses more elements than its fixed ceiling", () => {
    const voids = Array.from({ length: MATROSKA_MAX_ELEMENTS + 1 }, () => el(0xec));
    refuses(file([OPUS, DELAY, AUDIO_TYPE], { beforeTracks: voids }));
  });

  it("refuses an input longer than its fixed byte ceiling", () => {
    refuses(new Uint8Array(MATROSKA_READ_CEILING_BYTES + 1));
  });
});

describe("WebM audio CodecDelay reader — the local file boundary", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vf-mkv-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const read = (inputPath: string) => readLocalWebmAudioTrackTiming({ workDir, inputPath });
  const processingFailed = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "PROCESSING_FAILED");
      assert.ok(!/matroska|ebml|codec/i.test(err.message), "no parser detail reaches the error");
      return true;
    });

  it("reads a contained regular file", async () => {
    const path = join(workDir, "audio-source.webm");
    await writeFile(path, await pinnedHeader("opus"));
    assert.deepEqual(await read(path), { codec: "opus", codecDelayNs: 6_500_000 });
  });

  it("reads only the fixed prefix of a large file", async () => {
    const path = join(workDir, "audio-source.webm");
    const header = await pinnedHeader("vorbis");
    await writeFile(path, Buffer.concat([header, Buffer.alloc(3 * MATROSKA_READ_CEILING_BYTES, 0x55)]));
    assert.deepEqual(await read(path), { codec: "vorbis", codecDelayNs: 0 });
  });

  it("refuses a file whose track lies beyond the read ceiling", async () => {
    const path = join(workDir, "audio-source.webm");
    const voids = el(0xec, Buffer.alloc(MATROSKA_READ_CEILING_BYTES));
    await writeFile(path, file([OPUS, DELAY, AUDIO_TYPE], { beforeTracks: [voids] }));
    await processingFailed(() => read(path));
  });

  it("refuses symlinks, directories, escaping and remote paths, and non-Matroska bytes", async () => {
    const target = join(workDir, "real.webm");
    await writeFile(target, await pinnedHeader("opus"));
    const link = join(workDir, "link.webm");
    await symlink(target, link);
    const dir = join(workDir, "dir.webm");
    await mkdir(dir);
    const text = join(workDir, "text.webm");
    await writeFile(text, "audio-bytes");
    for (const path of [link, dir, "/etc/hosts", "http://example.com/a.webm", "relative.webm", text, join(workDir, "absent.webm")]) {
      await processingFailed(() => read(path));
    }
  });

  it("does nothing for an already-aborted caller", async () => {
    const path = join(workDir, "audio-source.webm");
    await writeFile(path, await pinnedHeader("opus"));
    const controller = new AbortController();
    controller.abort();
    await processingFailed(() => readLocalWebmAudioTrackTiming({ workDir, inputPath: path, signal: controller.signal }));
  });
});
