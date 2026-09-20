import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { runProcess } from "@/services/processing/process-runner.server";

/**
 * SPLIT-02: the LOCAL media probing primitive.
 *
 * This module knows nothing about yt-dlp, about the Worker's private split
 * pair schema, or about how a plan decided that two files belong together. It
 * is handed already-downloaded LOCAL paths and answers exactly two questions:
 *
 *   1. which approved container FAMILY is this, and
 *   2. which media stream KINDS does it contain?
 *
 * That deliberate narrowness is what keeps `services/processing` free of an
 * import edge into `worker/execution` (SPLIT-02 §46). SPLIT-01 remains the
 * authority on whether a PAIR is allowed; this module is the authority on
 * whether a FILE is safe to hand to FFmpeg.
 */

/**
 * The approved container families.
 *
 * These are APPLICATION-owned names, not FFmpeg's. FFmpeg reports a demuxer's
 * whole alias group rather than the specific subtype, so an upstream string is
 * never carried forward — it is normalized into one of these values or
 * rejected outright. See `FFPROBE_FORMAT_TOKENS` for why that matters.
 *
 * `mpegts` was added by HLS-4 so the dormant clear-HLS processing primitive can
 * validate the raw MPEG-TS artifact HLS-3 acquires before remuxing it. Adding a
 * family here widens exactly one thing — which explicit demuxer this probe is
 * able to select — and nothing else:
 *
 *   - the split merge targets (`SPLIT_MERGE_TARGETS`) are a separate closed
 *     union that still maps only onto `iso-bmff` and `webm`, so no split plan
 *     can ask for an MPEG-TS probe;
 *   - `hasExactStreamShape()` compares the family for EQUALITY, so a file that
 *     normalizes to `mpegts` can never satisfy an ISO-BMFF or WebM expectation;
 *   - nothing in Product execution reaches the HLS foundation at all.
 */
export const LOCAL_MEDIA_FAMILIES = ["iso-bmff", "webm", "mpegts"] as const;
export type LocalMediaFamily = (typeof LOCAL_MEDIA_FAMILIES)[number];

/** The only stream kinds this v1 validator will accept in a probed file. */
export type LocalMediaStreamKind = "video" | "audio";

/**
 * The closed result of a probe. Nothing else from ffprobe survives: no tags,
 * no titles, no comments, no source URLs, no codec strings, no durations.
 * SPLIT-02 needs the family and the stream shape, and taking more would mean
 * carrying attacker-influenced text further into execution for no purpose.
 */
export type LocalMediaProbe = {
  readonly family: LocalMediaFamily;
  readonly streams: readonly LocalMediaStreamKind[];
};

/**
 * The EXACT `-f` input format name used for each family, proven against the
 * accepted Worker image (ffmpeg/ffprobe 5.1.9-0+deb12u1, Debian Bookworm).
 *
 * Explicit demuxer selection is a security control, not a nicety: it stops
 * FFmpeg probing an attacker-shaped local file into some unrelated demuxer.
 * The pinned runtime accepts `mov`, `mp4`, `matroska` and `webm` as aliases
 * for the two relevant demuxers; the canonical FIRST token of each registered
 * alias group is used here so the name is stable and unambiguous.
 *
 * Verified in the pinned image: `-f mov` on a WebM file fails with "moov atom
 * not found", so the explicit demuxer really does refuse cross-family input
 * rather than silently re-detecting.
 *
 * MPEG-TS (HLS-4) has no alias group at all: its demuxer is registered under
 * the single name `mpegts`. Re-verified offline against the pinned FFmpeg
 * build, 5.1.9-0+deb12u1, in both directions — `-f mov` on a real MPEG-TS file
 * fails with "moov atom not found", and `-f mpegts` on a real MP4 fails with
 * "End of file". See `testdata/README.md` for exactly which image that capture
 * came from. The separate `mpegtsraw` demuxer is deliberately NOT used: it
 * exposes raw transport packets rather than the elementary streams this
 * validator has to count.
 */
const FFPROBE_INPUT_FORMAT: Record<LocalMediaFamily, string> = {
  "iso-bmff": "mov",
  webm: "matroska",
  mpegts: "mpegts",
};

/**
 * The EXACT `format_name` alias token sequences the pinned runtime emits.
 *
 * This is the load-bearing correction from design review (SPLIT-02 §28). The
 * accepted Worker image reports, verbatim:
 *
 *   MP4 video-only   -> "mov,mp4,m4a,3gp,3g2,mj2"
 *   M4A audio-only   -> "mov,mp4,m4a,3gp,3g2,mj2"
 *   merged MP4       -> "mov,mp4,m4a,3gp,3g2,mj2"
 *   WebM video-only  -> "matroska,webm"
 *   WebM audio-only  -> "matroska,webm"
 *   merged WebM      -> "matroska,webm"
 *   MPEG-TS          -> "mpegts"
 *
 * MPEG-TS is the one family whose reported name is a SINGLE token, because its
 * demuxer registers no aliases. That is not an exception to the exact-sequence
 * rule, it is the same rule applied to a one-element sequence: `"mpegts"`
 * matches, and `"mpegts,evil"`, `"evil,mpegts"` and `"mpegtsraw"` do not.
 *
 * So `format_name === "mp4"` is simply never true, and a substring test for
 * "mp4" would also accept "3gp" media and anything else sharing the group.
 * The alias string is therefore parsed as EXACT comma-delimited tokens and the
 * whole sequence must equal one of these approved sequences.
 *
 * Note what this consequently does NOT prove: because MP4 and M4A share one
 * alias group, `format_name` cannot distinguish them. It proves the FAMILY.
 * The subtype is supplied by the fixed-path acquisition policy and the SPLIT-01
 * pair table, and the stream SHAPE check below is what actually establishes
 * that a file is usable as the video half or the audio half.
 */
const FFPROBE_FORMAT_TOKENS: Record<LocalMediaFamily, readonly string[]> = {
  "iso-bmff": ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
  webm: ["matroska", "webm"],
  mpegts: ["mpegts"],
};

/**
 * HARD ceilings for the probe subprocess.
 *
 * A successful probe of the pinned runtime's own output is ~169 bytes, so
 * these are several orders of magnitude of headroom and still bound a
 * security-sensitive parser tightly. They are deliberately NOT the runner's
 * historical multi-megabyte lenient retention: on overflow `runProcess` kills
 * the owned process group and rejects, so a truncated document is never
 * parsed.
 */
const PROBE_MAX_STDOUT_BYTES = 64_000;
const PROBE_MAX_STDERR_BYTES = 16_000;

/**
 * Upper bound on stream entries accepted from one probe. The shapes SPLIT-02
 * allows have one or two streams; this only stops a pathological file from
 * turning into a large in-memory array before the shape check rejects it.
 */
const MAX_PROBE_STREAMS = 16;

/**
 * Shape of the ffprobe document, validated at runtime rather than trusted.
 *
 * Not `.strict()`: the pinned runtime also emits a `programs` array, and
 * demanding an exact key set would make an FFmpeg point release a Worker
 * outage. Only the two fields below are ever READ, so extra keys are inert.
 */
const FfprobeDocumentSchema = z.object({
  format: z.object({ format_name: z.string() }),
  streams: z.array(z.object({ codec_type: z.string() })),
});

/**
 * The absolute, operator-controlled ffprobe binary.
 *
 * ffprobe is NEVER resolved through `PATH`: a Worker whose `PATH` can be
 * influenced must not thereby choose which program parses untrusted media.
 * It is derived as the SIBLING of the configured absolute FFmpeg binary,
 * which is exactly how the accepted Worker image is laid out —
 * `FFMPEG_PATH=/usr/bin/ffmpeg` and Debian's `ffmpeg` package ships
 * `/usr/bin/ffprobe` next to it (both verified present in the accepted image).
 *
 * Deriving rather than adding a second setting keeps the operator with ONE
 * knob: there is no way to configure an FFmpeg from one place and an ffprobe
 * from another, and no browser, source or job input participates at all.
 *
 * A non-absolute `FFMPEG_PATH` fails closed here. The Worker's own config
 * loader validates the string but does not require absoluteness, so this is
 * the layer that refuses to turn a relative FFmpeg into a `PATH`-relative
 * probe.
 */
export function resolveFfprobePath(ffmpegPath: string = config.ffmpegPath): string {
  const value = ffmpegPath.trim();
  if (!value || !isAbsolute(value)) {
    throw new AppError("PROCESSING_FAILED");
  }
  const directory = dirname(value);
  if (!isAbsolute(directory)) {
    throw new AppError("PROCESSING_FAILED");
  }
  return resolve(directory, "ffprobe");
}

/**
 * Reject anything that is not a plain local filesystem path BEFORE any
 * filesystem work and long before any spawn.
 *
 * Deliberately separate from — and stricter than — `assertLocalMediaPath()` in
 * `ffmpeg.server.ts`, whose semantics existing callers depend on and which is
 * left untouched. This one additionally requires an absolute path, because the
 * split primitive is always given resolved job paths and a relative path there
 * would mean a caller lost track of the work directory.
 */
function assertPlainAbsoluteLocalPath(candidate: string): void {
  const value = candidate.trim();
  if (!value) throw new AppError("PROCESSING_FAILED");
  // A URI scheme ("http:", "file:", "data:", anything) or a protocol-relative
  // "//host/..." reference is not a local path, whatever the filesystem would
  // make of it.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//")) {
    throw new AppError("PROCESSING_FAILED");
  }
  if (value.includes("\0")) throw new AppError("PROCESSING_FAILED");
  if (!isAbsolute(value)) throw new AppError("PROCESSING_FAILED");
}

/**
 * PHYSICAL containment: is `candidate` really inside `workDir` on disk?
 *
 * String-prefix containment is not enough and is the classic way this check is
 * got wrong. Two concrete failures it must survive:
 *
 *   - a sibling directory that merely shares a prefix. With workDir `/tmp/job`,
 *     the path `/tmp/job2/x.mp4` starts with `/tmp/job` as a STRING but is a
 *     different directory. Comparing `path.relative()` segments rejects it.
 *   - a symlink inside the workDir pointing at `/etc/...`. The path text is
 *     impeccable; only resolving the link reveals the escape. Both sides are
 *     therefore `realpath`-resolved before comparison, so the comparison is
 *     between real locations rather than between spellings.
 *
 * `realpath` of the workDir matters independently: on macOS `/tmp` is itself a
 * symlink to `/private/tmp`, so resolving only one side would reject perfectly
 * legitimate paths.
 */
async function resolveContainedRealPath(workDir: string, candidate: string): Promise<string> {
  assertPlainAbsoluteLocalPath(workDir);
  assertPlainAbsoluteLocalPath(candidate);

  let workDirReal: string;
  let candidateReal: string;
  try {
    workDirReal = await realpath(resolve(workDir));
    candidateReal = await realpath(resolve(candidate));
  } catch {
    // A path that cannot be resolved cannot be proven contained.
    throw new AppError("PROCESSING_FAILED");
  }

  const rel = relative(workDirReal, candidateReal);
  // "" means the candidate IS the work directory; a ".." segment or an
  // absolute result means it lies outside it.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AppError("PROCESSING_FAILED");
  }
  return candidateReal;
}

/**
 * A local media file this primitive is willing to touch: physically inside the
 * work directory, and a REGULAR file.
 *
 * `lstat` (not `stat`) is used for the file-type check so the check describes
 * the entry that was named rather than whatever it points at. A symlink is
 * refused outright — stricter than merely refusing an ESCAPING symlink, and
 * cheaper to reason about: every path this primitive handles is one the job
 * itself wrote. Directories, FIFOs, devices and sockets are refused for the
 * same reason: FFmpeg would happily block forever on a FIFO.
 */
export async function assertContainedRegularFile(
  workDir: string,
  candidate: string,
): Promise<string> {
  const real = await resolveContainedRealPath(workDir, candidate);
  let entry;
  try {
    // The NAMED entry, not its resolution: `lstat(real)` would describe the
    // symlink's TARGET and wave every in-directory symlink through. Ancestor
    // symlinks are deliberately not refused here (macOS `/tmp` is one); the
    // realpath comparison above is what keeps those physically contained.
    entry = await lstat(resolve(candidate));
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }
  if (!entry.isFile()) throw new AppError("PROCESSING_FAILED");
  return real;
}

/**
 * The REAL path of the work directory, which must exist and be a directory.
 *
 * Resolved once by the merge primitive so the fixed output name is joined onto
 * the same real location every containment check compares against. Without
 * this, a workDir reached through a symlink (macOS `/tmp`) would produce an
 * output path that its own containment check then rejects.
 */
export async function assertWorkDirRealPath(workDir: string): Promise<string> {
  assertPlainAbsoluteLocalPath(workDir);
  let real: string;
  try {
    real = await realpath(resolve(workDir));
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }
  let entry;
  try {
    entry = await lstat(real);
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }
  if (!entry.isDirectory()) throw new AppError("PROCESSING_FAILED");
  return real;
}

/** Byte size of an already-validated regular file. */
export async function regularFileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new AppError("PROCESSING_FAILED");
    return info.size;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("PROCESSING_FAILED");
  }
}

/**
 * Normalize an ffprobe `format_name` into an approved family, or `null`.
 *
 * Exact token parsing, never substring matching: `"mp4"` alone, `"webm"`
 * alone, `"matroska,webm,evil"` and `"mov,,mp4"` are all rejected, because
 * none of them is a sequence the pinned runtime actually produces. Accepting a
 * string merely for CONTAINING a convenient token would let an unrelated
 * demuxer's alias group through.
 */
export function normalizeProbeFormatFamily(formatName: string): LocalMediaFamily | null {
  const tokens = formatName.split(",");
  if (tokens.length === 0) return null;
  // Every token must be a bare lowercase alphanumeric name. This rejects empty
  // tokens from a malformed list, padding whitespace, and anything exotic.
  if (!tokens.every((token) => /^[a-z0-9]+$/.test(token))) return null;

  for (const family of LOCAL_MEDIA_FAMILIES) {
    const approved = FFPROBE_FORMAT_TOKENS[family];
    if (tokens.length !== approved.length) continue;
    if (tokens.every((token, index) => token === approved[index])) return family;
  }
  return null;
}

/**
 * Parse one ffprobe JSON document into the closed probe result.
 *
 * Exported for direct testing: this is the parser that sees attacker-shaped
 * input, so it is pinned against captured runtime output rather than only
 * exercised through a subprocess.
 */
export function parseProbeDocument(raw: string): LocalMediaProbe {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }

  const parsed = FfprobeDocumentSchema.safeParse(json);
  if (!parsed.success) throw new AppError("PROCESSING_FAILED");

  const family = normalizeProbeFormatFamily(parsed.data.format.format_name);
  if (family === null) throw new AppError("PROCESSING_FAILED");

  const entries = parsed.data.streams;
  if (entries.length === 0 || entries.length > MAX_PROBE_STREAMS) {
    throw new AppError("PROCESSING_FAILED");
  }

  const streams: LocalMediaStreamKind[] = [];
  for (const entry of entries) {
    // Anything that is not plain video or audio — subtitle, data, attachment,
    // an unknown future kind — makes the file unsupported rather than merely
    // uninteresting. Dropping such a stream silently would let a file claim a
    // shape it does not have.
    if (entry.codec_type !== "video" && entry.codec_type !== "audio") {
      throw new AppError("PROCESSING_FAILED");
    }
    streams.push(entry.codec_type);
  }
  return { family, streams };
}

/**
 * The exact ffprobe argv. Pure and exported so an argv-policy test can pin
 * every security-relevant flag independently of any subprocess.
 */
export function buildProbeArgs(opts: {
  family: LocalMediaFamily;
  inputPath: string;
}): string[] {
  return [
    // Diagnostics only; a successful probe prints nothing on stderr.
    "-v",
    "error",
    // Local file access ONLY. Verified in the pinned runtime: an http input
    // under this whitelist fails with "Protocol 'http' not on whitelist
    // 'file'!" before any DNS or TCP work, whereas the same input WITHOUT it
    // proceeds to hostname resolution. Path validation alone would not stop a
    // crafted container from referencing a remote resource.
    "-protocol_whitelist",
    "file",
    // Explicit demuxer: never auto-detect an arbitrary format here.
    "-f",
    FFPROBE_INPUT_FORMAT[opts.family],
    "-print_format",
    "json",
    // EXACTLY the two fields this primitive needs. No tags, no titles, no
    // comments, no source URLs, no codec names, no durations.
    "-show_entries",
    "format=format_name:stream=codec_type",
    "-i",
    opts.inputPath,
  ];
}

/**
 * Probe ONE already-local file.
 *
 * The caller states which family it expects, because the expected family
 * chooses the explicit demuxer. The returned family is checked again by the
 * caller: the demuxer refuses cross-family input at the FFmpeg layer, and the
 * normalized `format_name` refuses it again at the application layer.
 */
export async function probeLocalMedia(opts: {
  inputPath: string;
  workDir: string;
  family: LocalMediaFamily;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<LocalMediaProbe> {
  // An already-cancelled caller gets no subprocess at all.
  if (opts.signal?.aborted) {
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  }
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  // Closed at compile time, re-checked at runtime: the family chooses the
  // demuxer, and an unmapped value must never become an `undefined` argv slot.
  if (!(LOCAL_MEDIA_FAMILIES as readonly string[]).includes(opts.family)) {
    throw new AppError("PROCESSING_FAILED");
  }

  const ffprobePath = resolveFfprobePath();
  const inputPath = await assertContainedRegularFile(opts.workDir, opts.inputPath);

  const result = await runProcess({
    command: ffprobePath,
    args: buildProbeArgs({ family: opts.family, inputPath }),
    timeoutMs: opts.timeoutMs,
    cwd: opts.workDir,
    signal: opts.signal,
    maxStdoutBytes: PROBE_MAX_STDOUT_BYTES,
    maxStderrBytes: PROBE_MAX_STDERR_BYTES,
  });

  // Verified in the pinned runtime: ffprobe exits 1 both for a blocked
  // protocol and for a file the explicit demuxer refuses, while still printing
  // an empty `{}` document on stdout. Gating on the exit code first means that
  // empty document is never even offered to the parser.
  if (result.code !== 0) throw new AppError("PROCESSING_FAILED");

  return parseProbeDocument(result.stdout);
}

/**
 * Does a probe result have EXACTLY the expected shape?
 *
 * Ambiguity is rejected rather than resolved. A file with two video streams,
 * or a "video-only" half that turns out to be muxed, is not merely awkward to
 * map — it means the file is not what the plan said it was, and picking the
 * first convenient stream would substitute media the user never asked for.
 */
export function hasExactStreamShape(
  probe: LocalMediaProbe,
  expected: { family: LocalMediaFamily; video: number; audio: number },
): boolean {
  if (probe.family !== expected.family) return false;
  const video = probe.streams.filter((kind) => kind === "video").length;
  const audio = probe.streams.filter((kind) => kind === "audio").length;
  return (
    video === expected.video &&
    audio === expected.audio &&
    probe.streams.length === expected.video + expected.audio
  );
}
