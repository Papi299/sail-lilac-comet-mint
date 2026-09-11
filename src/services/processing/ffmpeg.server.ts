import { access, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  assertContainedRegularFile,
  assertWorkDirRealPath,
  hasExactStreamShape,
  probeLocalMedia,
  regularFileSize,
  type LocalMediaFamily,
} from "@/services/processing/ffprobe.server";
import { runProcess } from "@/services/processing/process-runner.server";

export function assertLocalMediaPath(inputPath: string): void {
  const value = inputPath.trim();
  if (!value || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//")) {
    throw new AppError("PROCESSING_FAILED");
  }
}

export async function ffmpegAvailable(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) signal.throwIfAborted();
  try {
    await access(config.ffmpegPath);
    const result = await runProcess({
      command: config.ffmpegPath,
      args: ["-version"],
      timeoutMs: 8_000,
      signal,
    });
    return (result.stdout + result.stderr).toLowerCase().includes("ffmpeg version");
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return false;
  }
}

export async function convertMedia(opts: {
  inputPath: string;
  workDir: string;
  target: "mp4" | "webm" | "mp3" | "m4a";
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: number | null) => void;
}): Promise<string> {
  assertLocalMediaPath(opts.inputPath);
  const outName =
    opts.target === "mp3" ? "converted.mp3" : opts.target === "webm" ? "converted.webm" : opts.target === "m4a" ? "converted.m4a" : "converted.mp4";
  const outputPath = join(opts.workDir, outName);
  const args =
    opts.target === "mp3"
      ? [
          "-y",
          "-nostdin",
          "-i",
          opts.inputPath,
          "-vn",
          "-c:a",
          "libmp3lame",
          "-q:a",
          "2",
          outputPath,
        ]
      : opts.target === "m4a"
      ? [
          "-y",
          "-nostdin",
          "-i",
          opts.inputPath,
          "-vn",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          outputPath,
        ]
      : opts.target === "webm"
        ? [
            "-y",
            "-nostdin",
            "-i",
            opts.inputPath,
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "32",
            "-c:a",
            "libopus",
            outputPath,
          ]
        : [
            "-y",
            "-nostdin",
            "-i",
            opts.inputPath,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            outputPath,
          ];

  opts.onProgress?.(null);
  const result = await runProcess({
    command: config.ffmpegPath,
    args,
    timeoutMs: opts.timeoutMs,
    cwd: opts.workDir,
    signal: opts.signal,
  });
  if (result.code !== 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  opts.onProgress?.(100);
  return outputPath;
}

export async function remuxCopy(opts: {
  inputPath: string;
  workDir: string;
  ext: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  assertLocalMediaPath(opts.inputPath);
  const outputPath = join(opts.workDir, `remux.${opts.ext}`);
  const result = await runProcess({
    command: config.ffmpegPath,
    args: ["-y", "-nostdin", "-i", opts.inputPath, "-c", "copy", "-movflags", "+faststart", outputPath],
    timeoutMs: opts.timeoutMs,
    cwd: opts.workDir,
    signal: opts.signal,
  });
  if (result.code !== 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  return outputPath;
}

export function probeFromFfmpegOutput(stderr: string): {
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
} {
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  let duration: number | null = null;
  if (durationMatch) {
    duration =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  }
  const videoMatch = stderr.match(
    /Stream #0:\d+.*Video:\s*([a-zA-Z0-9_]+).*?(\d{2,5})x(\d{2,5})(?:.*?(\d+(?:\.\d+)?)\s*fps)?/,
  );
  const audioMatch = stderr.match(/Stream #0:\d+.*Audio:\s*([a-zA-Z0-9_]+)/);
  const containerMatch = stderr.match(/Input #0,\s*([^,]+),/);
  return {
    duration,
    videoCodec: videoMatch?.[1] ?? null,
    width: videoMatch?.[2] ? Number(videoMatch[2]) : null,
    height: videoMatch?.[3] ? Number(videoMatch[3]) : null,
    fps: videoMatch?.[4] ? Number(videoMatch[4]) : null,
    audioCodec: audioMatch?.[1] ?? null,
    container: containerMatch?.[1]?.split(",")[0]?.trim() ?? null,
  };
}

export async function generateSampleClip(workDir: string, timeoutMs: number): Promise<string> {
  const outputPath = join(workDir, "sample.mp4");
  const result = await runProcess({
    command: config.ffmpegPath,
    args: [
      "-y",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=5:size=1280x720:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    timeoutMs,
    cwd: workDir,
  });
  if (result.code !== 0) {
    throw new AppError("PROCESSING_FAILED", `Could not generate sample clip. ${basename(outputPath)}`);
  }
  return outputPath;
}

/**
 * SPLIT-02: the LOCAL two-input stream-copy merge primitive.
 *
 * ─── Reachability ───────────────────────────────────────────────────────────
 *
 * Since SPLIT-04 the JobExecutor calls this for a `merge-split` plan, strictly
 * after `beginProcessing()` commits, on the two halves SPLIT-03 acquired. But
 * no analysis path builds a split preset source yet, so no `merge-split` plan
 * exists in Production and no real download job reaches this function.
 * Executor support exists; product reachability does not.
 *
 * ─── Lifecycle ──────────────────────────────────────────────────────────────
 *
 * When it IS wired up, this runs in `processing`, never in `downloading`.
 * `downloading` is network acquisition; this primitive touches no network at
 * all and refuses to be pointed at one (see the protocol whitelist below).
 *
 * ─── Layering ───────────────────────────────────────────────────────────────
 *
 * The vocabulary here is closed and local: a target of "mp4" or "webm", two
 * local paths, a work directory and two bounds. It imports nothing from
 * `worker/execution` — not the pair schema, not the plan, not the preset
 * types. SPLIT-01 decides whether a PAIR is allowed; this decides whether the
 * FILES are safe to process. Later Worker code adapts one to the other.
 */

/**
 * The only merges SPLIT-02 can perform. The target determines the expected
 * family of BOTH inputs and the output muxer, so no source-controlled string
 * ever reaches an FFmpeg argument.
 *
 *   mp4  : ISO-BMFF video-only + ISO-BMFF audio-only -> MP4
 *   webm : WebM video-only     + WebM audio-only     -> WebM
 */
export const SPLIT_MERGE_TARGETS = ["mp4", "webm"] as const;
export type SplitMergeTarget = (typeof SPLIT_MERGE_TARGETS)[number];

const SPLIT_MERGE_FAMILY: Record<SplitMergeTarget, LocalMediaFamily> = {
  mp4: "iso-bmff",
  webm: "webm",
};

/**
 * The EXACT `-f` names for each side of the merge, proven against the accepted
 * Worker image (ffmpeg 5.1.9-0+deb12u1).
 *
 * INPUT names are the canonical first token of the registered demuxer alias
 * group (`mov,mp4,m4a,3gp,3g2,mj2` and `matroska,webm`); both were confirmed
 * to work as `-f` values on real files in that image. OUTPUT names are the
 * distinct muxers `mp4` and `webm`, so the container is chosen by the closed
 * target rather than inferred from the output filename's extension.
 */
const SPLIT_INPUT_FORMAT: Record<SplitMergeTarget, string> = {
  mp4: "mov",
  webm: "matroska",
};
const SPLIT_OUTPUT_FORMAT: Record<SplitMergeTarget, string> = {
  mp4: "mp4",
  webm: "webm",
};

/**
 * Application-owned, fixed output names. Never derived from a media title, a
 * source URL, a yt-dlp format id, a codec string or any browser input, and
 * never given an arbitrary extension.
 */
const SPLIT_OUTPUT_NAME: Record<SplitMergeTarget, string> = {
  mp4: "merged.mp4",
  webm: "merged.webm",
};

/**
 * HARD ceilings for the merge subprocess. At `-v error` a successful
 * stream-copy merge is silent, so these bound a failure mode rather than
 * normal operation, and no FFmpeg diagnostic is retained beyond them.
 */
const MERGE_MAX_STDOUT_BYTES = 64_000;
const MERGE_MAX_STDERR_BYTES = 256_000;

/**
 * The exact merge argv. Pure and exported so an argv-policy test can pin every
 * security-relevant flag without spawning anything.
 *
 * Fixed per target. There is no path by which a caller, a source, or a codec
 * string can add, remove or reorder an argument.
 */
export function buildSplitMergeArgs(opts: {
  target: SplitMergeTarget;
  videoPath: string;
  audioPath: string;
  outputPath: string;
}): string[] {
  const inputFormat = SPLIT_INPUT_FORMAT[opts.target];
  return [
    // SPLIT-04: NEVER overwrite. `mergeSplitMedia` refuses an existing output
    // entry before spawning; `-n` makes FFmpeg refuse one that appeared between
    // that check and FFmpeg's own existence check, instead of truncating it.
    // `-y` is deliberately absent. This is the split merge only — the other
    // FFmpeg commands in this module are unchanged.
    "-n",
    "-nostdin",
    "-v",
    "error",

    // INPUT 0 — the video-only half.
    //
    // `-protocol_whitelist file` is a per-input demuxer option and is the
    // control that stops a crafted local container from inducing a SECONDARY
    // network fetch. Verified in the pinned image: an http input under this
    // whitelist fails with "Protocol 'http' not on whitelist 'file'!" before
    // any DNS lookup, while the same input without it proceeds to resolve the
    // hostname. Local-path validation alone would not catch that, because the
    // path handed to FFmpeg really is local — it is the file's CONTENTS that
    // name the remote resource.
    "-protocol_whitelist",
    "file",
    "-f",
    inputFormat,
    "-i",
    opts.videoPath,

    // INPUT 1 — the audio-only half. Same policy; the whitelist is per-input,
    // so it must be repeated rather than stated once.
    "-protocol_whitelist",
    "file",
    "-f",
    inputFormat,
    "-i",
    opts.audioPath,

    // Explicit stream mapping. Exactly one video stream from input 0 and
    // exactly one audio stream from input 1 — never FFmpeg's default stream
    // selection, which would pick by its own heuristics.
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",

    // STREAM COPY ONLY. No encoder is named anywhere, and there is no
    // transcode fallback: a pair that cannot be copied makes FFmpeg exit
    // non-zero, and that is reported as a failure rather than silently
    // re-encoded into something the user did not request.
    "-c:v",
    "copy",
    "-c:a",
    "copy",

    // The artifact needs video and audio, not upstream metadata. Both inputs'
    // global metadata and chapters are dropped rather than merged forward.
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",

    // Deliberately absent: `-shortest`. A slightly shorter audio track must
    // not truncate the video the user actually asked for; natural duration
    // mismatch is preserved. Changing that is a semantic decision, not a flag.

    // MP4 only. `+faststart` was verified compatible with this exact
    // stream-copy command in the pinned runtime; it is an ISO-BMFF concept and
    // is never injected into the WebM command.
    ...(opts.target === "mp4" ? ["-movflags", "+faststart"] : []),

    // Fixed output muxer, chosen by the closed target. The extension is not
    // what decides the container.
    "-f",
    SPLIT_OUTPUT_FORMAT[opts.target],
    opts.outputPath,
  ];
}

/**
 * Whether ANY directory entry exists at `path` — a file, a directory, or a
 * symlink, dangling or not. `lstat` rather than `stat`/`access`, so a dangling
 * symlink counts as present instead of looking like free space.
 */
async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AppError("PROCESSING_FAILED");
  }
}

/**
 * Merge one already-downloaded video-only file with one already-downloaded
 * audio-only file, by stream copy, into a validated local artifact.
 *
 * Every input is local, every bound is caller-supplied and explicit, and every
 * stage fails closed. Returns the absolute output path.
 */
export async function mergeSplitMedia(opts: {
  videoPath: string;
  audioPath: string;
  workDir: string;
  target: SplitMergeTarget;
  timeoutMs: number;
  /**
   * HARD bound on the FINAL artifact. This is the authoritative size check:
   * any headroom a future acquisition budget allows itself is an operational
   * allowance for temporary files, never proof of the merged artifact's size.
   */
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  // An already-cancelled caller gets no subprocess at all — not the probes,
  // not the merge.
  if (opts.signal?.aborted) {
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  }
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  if (!Number.isSafeInteger(opts.maxOutputBytes) || opts.maxOutputBytes <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  // The target is a closed union at compile time; a value that arrived by a
  // cast or across a boundary is checked again, because it chooses both
  // demuxers, the muxer and the output name.
  if (!(SPLIT_MERGE_TARGETS as readonly string[]).includes(opts.target)) {
    throw new AppError("PROCESSING_FAILED");
  }

  const family = SPLIT_MERGE_FAMILY[opts.target];

  // 1. Both inputs must be physically inside the work directory and be regular
  //    files. This runs BEFORE any spawn, so a remote URL, a protocol-relative
  //    reference, an escaping symlink or a FIFO never reaches a subprocess.
  const videoPath = await assertContainedRegularFile(opts.workDir, opts.videoPath);
  const audioPath = await assertContainedRegularFile(opts.workDir, opts.audioPath);
  if (videoPath === audioPath) throw new AppError("PROCESSING_FAILED");

  // 2. The output is application-named and must collide with neither input.
  //    Resolved against the REAL work directory so the comparison is between
  //    real locations rather than spellings.
  const workDirReal = await assertWorkDirRealPath(opts.workDir);
  const outputPath = join(workDirReal, SPLIT_OUTPUT_NAME[opts.target]);
  if (outputPath === videoPath || outputPath === audioPath) {
    throw new AppError("PROCESSING_FAILED");
  }

  // ...and nothing may already exist at that name. FFmpeg's file protocol
  // FOLLOWS symlinks, so a pre-placed `merged.mp4 -> /elsewhere` would be
  // written through rather than replaced. The work directory is job-owned, so
  // an existing entry is stale or foreign state: refusing is fail-closed,
  // deleting it would be a guess.
  //
  // This check and FFmpeg's open are separate moments. The merge argv
  // therefore carries `-n` (SPLIT-04), so an entry that exists by the time
  // FFmpeg checks is refused by FFmpeg too, rather than truncated. `-n` is
  // FFmpeg's `access(F_OK)`, which follows symlinks: it refuses an existing
  // file and a live symlink, but not a DANGLING one. What makes the residual
  // window harmless is ownership — the job directory has no writer but this
  // job — and the produced file is still re-validated (a symlink is refused)
  // after FFmpeg exits.
  if (await pathEntryExists(outputPath)) throw new AppError("PROCESSING_FAILED");

  // 3. Input stream shapes. Ambiguous media is refused, never disambiguated:
  //    a muxed file used as the video half would make the job acquire audio
  //    twice and then discard the source's own track.
  const videoProbe = await probeLocalMedia({
    inputPath: videoPath,
    workDir: workDirReal,
    family,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (!hasExactStreamShape(videoProbe, { family, video: 1, audio: 0 })) {
    throw new AppError("PROCESSING_FAILED");
  }

  const audioProbe = await probeLocalMedia({
    inputPath: audioPath,
    workDir: workDirReal,
    family,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (!hasExactStreamShape(audioProbe, { family, video: 0, audio: 1 })) {
    throw new AppError("PROCESSING_FAILED");
  }

  // 4. The merge itself. The caller's AbortSignal goes straight into
  //    `runProcess`, which owns a POSIX process group and kills the whole
  //    group on abort or timeout.
  const result = await runProcess({
    command: config.ffmpegPath,
    args: buildSplitMergeArgs({
      target: opts.target,
      videoPath,
      audioPath,
      outputPath,
    }),
    timeoutMs: opts.timeoutMs,
    cwd: workDirReal,
    signal: opts.signal,
    maxStdoutBytes: MERGE_MAX_STDOUT_BYTES,
    maxStderrBytes: MERGE_MAX_STDERR_BYTES,
  });
  // No raw FFmpeg stderr reaches the AppError; the exit code is the whole
  // report.
  if (result.code !== 0) throw new AppError("PROCESSING_FAILED");

  // 5. The artifact is validated, not assumed. FFmpeg exiting zero is not by
  //    itself proof that the file on disk is a contained, bounded, correctly
  //    shaped video-with-audio.
  const producedPath = await assertContainedRegularFile(workDirReal, outputPath);
  if (producedPath !== outputPath) throw new AppError("PROCESSING_FAILED");

  const size = await regularFileSize(producedPath);
  if (size <= 0) throw new AppError("PROCESSING_FAILED");
  if (size > opts.maxOutputBytes) throw new AppError("TOO_LARGE");

  const outputProbe = await probeLocalMedia({
    inputPath: producedPath,
    workDir: workDirReal,
    family,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (!hasExactStreamShape(outputProbe, { family, video: 1, audio: 1 })) {
    throw new AppError("PROCESSING_FAILED");
  }

  return producedPath;
}
