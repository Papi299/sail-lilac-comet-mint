import { join } from "node:path";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { mergeSplitMedia } from "@/services/processing/ffmpeg.server";
import {
  assertContainedRegularFile,
  assertWorkDirRealPath,
  regularFileSize,
} from "@/services/processing/ffprobe.server";
import type { WorkerErrorCode } from "@/shared/worker/errors";
import {
  ClearHlsAcquisitionError,
  SEPARATE_AUDIO_FMP4_FILE_NAME,
  SEPARATE_VIDEO_FMP4_FILE_NAME,
  acquireClearHlsSeparateAudioFmp4,
  acquireClearHlsSeparateVideoFmp4,
  hlsV1EffectiveAggregateLimitBytes,
  type ClearHlsAcquiredFmp4,
  type ClearHlsAcquisitionProgress,
} from "./hls-fragment-acquisition.server.ts";
import {
  CLEAR_HLS_ACQUISITION_ERROR_CODES,
  CLEAR_HLS_PREFLIGHT_ERROR_CODES,
} from "./hls-execution.server.ts";
import { ClearHlsPreflightError, preflightClearHlsMediaPlaylist } from "./hls-preflight.server.ts";
import { parseAcquiredFmp4Artifact, type ClearHlsProcessedMp4 } from "./hls-processing.server.ts";

/**
 * Worker-owned SEPARATE-AUDIO CLEAR-HLS EXECUTION ORCHESTRATION
 * (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The narrow seam between the durable JobExecutor and the third clear-HLS
 * family: a video-only fMP4 media playlist plus the ONE audio-only fMP4 media
 * playlist analysis proved, from the fetched Master Playlist, belongs to it.
 * Like `hls-execution.server.ts` for the muxed families, it owns the mapping of
 * every private HLS failure onto the existing public `WorkerErrorCode`
 * vocabulary — it reuses that module's two mapping TABLES — so the executor
 * learns no HLS enum. Two entry points, one per durable phase:
 *
 *   downloading   `acquireSelectedSeparateHlsMedia()` — the VIDEO playlist's
 *                 HLS-2 preflight, then the AUDIO playlist's, then HLS-3
 *                 acquisition of the video half and then the audio half. No
 *                 ffprobe, no FFmpeg, no container inspection.
 *
 *   processing    `processAcquiredSeparateHlsMedia()` — the shared two-input
 *                 local merge, and nothing else.
 *
 * ─── The subset ─────────────────────────────────────────────────────────────
 *
 * fMP4 + fMP4 ONLY. Each half is preflighted on its own by the unchanged HLS-2
 * path — so every construct the media grammar refuses is refused here too — and
 * BOTH plans must be `fmp4` before a single media byte is requested. MPEG-TS on
 * either side is `FORMAT_UNAVAILABLE`. A media playlist does not say whether it
 * carries video or audio; that is decided after `beginProcessing()` by the real
 * ffprobe shape checks inside the merge.
 *
 * ─── One budget, one deadline ───────────────────────────────────────────────
 *
 * The two acquisitions share ONE combined byte counter and ONE deadline, as the
 * generic split download does for its two halves: the video half may use the
 * effective Product limit; the audio half is handed exactly what is left of it
 * (`maxAggregateBytes`), so the pair together can never pass the ceiling and
 * neither half can consume it alone. The workspace footprint therefore stays
 * 2 × `maxFileSize`: both halves (≤ max together) plus the merged MP4 (≤ max).
 *
 * ─── Synchronization ────────────────────────────────────────────────────────
 *
 * The merge is the SHARED local-media merge seam, `mergeSplitMedia()` with the
 * `mp4` target — its own closed vocabulary of two local paths and a target,
 * with no split-plan type. It probes each half (exactly one video and zero
 * audio; exactly one audio and zero video; ISO-BMFF through the explicit `mov`
 * demuxer), reads their container start times, and applies the ONE MP4
 * synchronization authority of `merge-sync.ts` (PR #107): the earlier-starting
 * input is the `-isync` reference, video on an exact tie, so a relative A/V
 * offset survives and neither input is zeroed on its own. It then stream-copies
 * into a faststart MP4 and validates the output's size and exact one-video +
 * one-audio shape. Nothing here restates that algorithm, and the Matroska /
 * Opus CodecDelay handling of the WebM target is never reached.
 *
 * ─── Privacy ────────────────────────────────────────────────────────────────
 *
 * Both playlist URLs are SENSITIVE. They are read once, handed to HLS-2, and
 * never logged, persisted, returned or interpolated into an error: every
 * private failure is DROPPED and replaced by a canonical `AppError`.
 */

// ── Failure mapping ──────────────────────────────────────────────────────────

/** One closed reason through one mapping table, fail-closed on a forged value. */
function mappedCode<K extends string>(
  table: Readonly<Record<K, WorkerErrorCode>>,
  reason: K,
): WorkerErrorCode {
  return Object.prototype.hasOwnProperty.call(table, reason) ? table[reason] : "PROCESSING_FAILED";
}

function preflightAppError(err: unknown): AppError {
  if (err instanceof ClearHlsPreflightError) {
    return new AppError(mappedCode(CLEAR_HLS_PREFLIGHT_ERROR_CODES, err.reason));
  }
  return new AppError("PROCESSING_FAILED");
}

function acquisitionAppError(err: unknown): AppError {
  if (err instanceof ClearHlsAcquisitionError) {
    return new AppError(mappedCode(CLEAR_HLS_ACQUISITION_ERROR_CODES, err.reason));
  }
  return new AppError("PROCESSING_FAILED");
}

/** Run one primitive, translating anything it throws through `translate`. */
async function translated<T>(run: () => Promise<T>, translate: (err: unknown) => AppError): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw translate(err);
  }
}

// ── The acquisition phase ────────────────────────────────────────────────────

/**
 * What one separate-audio acquisition needs, and nothing more: the plan typed
 * on its literal operation, carrying the two proven playlist URLs. No master
 * URL, group id, header, cookie, referer or yt-dlp option exists here.
 */
export type ClearHlsSeparateAudioAcquisitionOrder = {
  readonly plan: {
    readonly operation: "clear-hls-separate-audio-remux";
    readonly source: { readonly videoPlaylistUrl: string; readonly audioPlaylistUrl: string };
  };
  readonly workDir: string;
  readonly signal: AbortSignal;
  /** May only NARROW the one shared acquisition deadline. */
  readonly acquisitionTimeoutMs?: number;
  readonly onProgress?: (progress: ClearHlsAcquisitionProgress) => void;
};

/** Both committed halves, and their proven combined size. */
export type ClearHlsSeparateAudioAcquired = {
  readonly video: ClearHlsAcquiredFmp4;
  readonly audio: ClearHlsAcquiredFmp4;
  readonly totalFileSize: number;
};

/** The primitives this seam composes, injectable as ONE object for lifecycle tests. */
export type ClearHlsSeparateAudioAcquisitionPrimitives = {
  readonly preflight: typeof preflightClearHlsMediaPlaylist;
  readonly acquireVideo: typeof acquireClearHlsSeparateVideoFmp4;
  readonly acquireAudio: typeof acquireClearHlsSeparateAudioFmp4;
};

const PRODUCTION_ACQUISITION_PRIMITIVES: ClearHlsSeparateAudioAcquisitionPrimitives = {
  preflight: preflightClearHlsMediaPlaylist,
  acquireVideo: acquireClearHlsSeparateVideoFmp4,
  acquireAudio: acquireClearHlsSeparateAudioFmp4,
};

/**
 * One monotonic progress stream over BOTH halves, by fragment count.
 *
 * Both fragment counts are known once both preflights succeeded, so each
 * half's own truthful fragment-count percentage is weighted by its share of the
 * total. Mid-acquisition values are floored and capped at 99: the terminal 100
 * is emitted by this seam alone, after BOTH halves committed. Byte counts are
 * actual bytes — the video half's, then the committed video bytes plus the
 * audio half's. Observer-only: a reporter that throws is dropped whole, exactly
 * as HLS-3 drops one.
 */
function pairProgress(
  onProgress: ClearHlsSeparateAudioAcquisitionOrder["onProgress"],
  videoFragments: number,
  audioFragments: number,
) {
  const total = videoFragments + audioFragments;
  const emit = (progress: number, downloadedBytes: number) => {
    if (onProgress === undefined) return;
    try {
      onProgress({ progress, downloadedBytes, totalBytes: null, speed: null, eta: null, stage: "downloading" });
    } catch {
      // Observer output only; the caller's exception is dropped whole.
    }
  };
  const share = (percent: number, fragments: number) => (Math.max(0, Math.min(100, percent)) * fragments) / total;
  return {
    video: (p: ClearHlsAcquisitionProgress) =>
      emit(Math.min(99, Math.floor(share(p.progress, videoFragments))), p.downloadedBytes),
    audio: (videoBytes: number) => (p: ClearHlsAcquisitionProgress) =>
      emit(
        Math.min(99, Math.floor(share(100, videoFragments) + share(p.progress, audioFragments))),
        videoBytes + p.downloadedBytes,
      ),
    done: (totalBytes: number) => emit(100, totalBytes),
  };
}

/**
 * The whole DOWNLOADING phase of a separate-audio job. Runs entirely while the
 * durable job says `downloading` and performs no local media work.
 *
 *   1. preflight the VIDEO media playlist (HLS-2, unchanged);
 *   2. preflight the AUDIO media playlist (HLS-2, unchanged);
 *   3. require BOTH plans to be fMP4;
 *   4. acquire the video half — map, then fragments — into `hls-video.fmp4`;
 *   5. acquire the audio half into `hls-audio.fmp4`, within what the video half
 *      left of the ONE byte budget and the ONE deadline;
 *   6. assert the combined size one final time.
 *
 * Either half failing fails the whole call; there is no partial result and no
 * fallback to one half. The workDir is the executor's to remove.
 */
export async function acquireSelectedSeparateHlsMedia(
  order: ClearHlsSeparateAudioAcquisitionOrder,
  primitives: ClearHlsSeparateAudioAcquisitionPrimitives = PRODUCTION_ACQUISITION_PRIMITIVES,
): Promise<ClearHlsSeparateAudioAcquired> {
  const { workDir, signal, acquisitionTimeoutMs, onProgress } = order;
  // The sensitive values are read ONCE; the plan is not consulted again.
  const { videoPlaylistUrl, audioPlaylistUrl } = order.plan.source;

  const videoPlan = await translated(
    () => primitives.preflight({ playlistUrl: videoPlaylistUrl, signal }),
    preflightAppError,
  );
  const audioPlan = await translated(
    () => primitives.preflight({ playlistUrl: audioPlaylistUrl, signal }),
    preflightAppError,
  );
  // fMP4 + fMP4 only: an MPEG-TS half on either side is outside the family,
  // refused before any media byte is requested.
  if (videoPlan.segmentType !== "fmp4" || audioPlan.segmentType !== "fmp4") {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  // ONE deadline for both acquisitions, capped by the application download
  // budget; each half receives only what is left of it.
  const ceiling = config.downloadTimeoutMs;
  const budgetMs = acquisitionTimeoutMs === undefined ? ceiling : Math.min(acquisitionTimeoutMs, ceiling);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new AppError("TIMEOUT");
  const deadline = performance.now() + budgetMs;
  const remainingMs = (): number => {
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) throw new AppError("TIMEOUT");
    return left;
  };

  const progress = pairProgress(onProgress, videoPlan.fragmentCount, audioPlan.fragmentCount);
  const limit = hlsV1EffectiveAggregateLimitBytes();

  const videoTimeoutMs = remainingMs();
  const video = await translated(
    () =>
      primitives.acquireVideo({
        plan: videoPlan,
        workDir,
        signal,
        timeoutMs: videoTimeoutMs,
        onProgress: progress.video,
      }),
    acquisitionAppError,
  );
  // The ONE combined byte counter: the audio half may use only what the video
  // half's ACTUAL bytes left of the effective limit.
  const allowance = limit - video.fileSize;
  if (!Number.isSafeInteger(video.fileSize) || allowance <= 0) throw new AppError("TOO_LARGE");
  const audioTimeoutMs = remainingMs();
  const audio = await translated(
    () =>
      primitives.acquireAudio({
        plan: audioPlan,
        workDir,
        signal,
        timeoutMs: audioTimeoutMs,
        maxAggregateBytes: allowance,
        onProgress: progress.audio(video.fileSize),
      }),
    acquisitionAppError,
  );
  const totalFileSize = video.fileSize + audio.fileSize;
  if (!Number.isSafeInteger(totalFileSize) || totalFileSize > limit) throw new AppError("TOO_LARGE");
  if (video.filePath === audio.filePath) throw new AppError("PROCESSING_FAILED");
  const result = Object.freeze({ video, audio, totalFileSize });
  progress.done(totalFileSize);
  return result;
}

// ── The processing phase ─────────────────────────────────────────────────────

/** What one separate-audio merge needs; `source` is the EXACT acquisition result. */
export type ClearHlsSeparateAudioProcessingOrder = {
  readonly source: ClearHlsSeparateAudioAcquired;
  readonly workDir: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
};

/** The shared local merge, injectable for lifecycle tests. Production: `mergeSplitMedia`. */
export type ClearHlsSeparateAudioProcessingPrimitives = {
  readonly merge: typeof mergeSplitMedia;
};

const PRODUCTION_PROCESSING_PRIMITIVES: ClearHlsSeparateAudioProcessingPrimitives = {
  merge: mergeSplitMedia,
};

const ACQUIRED_PAIR_FIELDS = ["video", "audio", "totalFileSize"] as const;

/**
 * PARSE the acquisition result into validated primitives, the HLS-4 way: a
 * frozen ordinary object with exactly three own data properties, each half
 * parsed by HLS-4's own fMP4 artifact parser, and a total that is their exact
 * safe sum. Past this call the caller's object is never read again.
 */
function parseAcquiredPair(value: unknown): {
  readonly video: { readonly filePath: string; readonly fileSize: number };
  readonly audio: { readonly filePath: string; readonly fileSize: number };
} | null {
  if (typeof value !== "object" || value === null) return null;
  if (!Object.isFrozen(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (Reflect.ownKeys(value).length !== ACQUIRED_PAIR_FIELDS.length) return null;
  const captured: Record<string, unknown> = {};
  for (const field of ACQUIRED_PAIR_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  const video = parseAcquiredFmp4Artifact(captured.video);
  const audio = parseAcquiredFmp4Artifact(captured.audio);
  if (video === null || audio === null) return null;
  const sum = video.fileSize + audio.fileSize;
  if (!Number.isSafeInteger(sum) || captured.totalFileSize !== sum) return null;
  if (video.filePath === audio.filePath) return null;
  return Object.freeze({ video, audio });
}

type StopCause = "cancelled" | "timeout";

function stopFailure(cause: StopCause): AppError {
  return cause === "timeout" ? new AppError("TIMEOUT") : new AppError("PROCESSING_FAILED", "Download was cancelled.");
}

/**
 * The whole PROCESSING phase: reached only after `beginProcessing()` committed.
 *
 *   1. parse the acquisition result into a snapshot, before any I/O;
 *   2. prove each half is a contained regular file at its OWN fixed HLS-3 name
 *      in the real work directory, with its declared size;
 *   3. hand the two local paths to the shared merge (`mp4` target) under ONE
 *      deadline — the merge probes both halves' exact shapes and start times,
 *      applies the shared synchronization decision, stream-copies to a
 *      faststart MP4, and validates the output's size and shape;
 *   4. re-check the produced file is the merge's own contained MP4, within the
 *      ceiling, and never one of the halves.
 *
 * Canonical `AppError`s pass through (`PROCESSING_FAILED`, `TOO_LARGE`,
 * `TIMEOUT`); anything else collapses to `PROCESSING_FAILED`; a stop is
 * reported as its first cause. No path, URL or tool output reaches an error.
 */
export async function processAcquiredSeparateHlsMedia(
  order: ClearHlsSeparateAudioProcessingOrder,
  primitives: ClearHlsSeparateAudioProcessingPrimitives = PRODUCTION_PROCESSING_PRIMITIVES,
): Promise<ClearHlsProcessedMp4> {
  const { workDir, timeoutMs, maxOutputBytes, signal } = order;
  if (signal.aborted) throw stopFailure("cancelled");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new AppError("PROCESSING_FAILED");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new AppError("PROCESSING_FAILED");
  const pair = parseAcquiredPair(order.source);
  if (pair === null) throw new AppError("PROCESSING_FAILED");

  let stopped: StopCause | null = null;
  const controller = new AbortController();
  const stop = (cause: StopCause) => {
    if (stopped !== null) return;
    stopped = cause;
    controller.abort();
  };
  const onCallerAbort = () => stop("cancelled");
  signal.addEventListener("abort", onCallerAbort, { once: true });
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => stop("timeout"), timeoutMs);

  try {
    const workDirReal = await assertWorkDirRealPath(workDir);
    const videoPath = await assertContainedRegularFile(workDirReal, pair.video.filePath);
    const audioPath = await assertContainedRegularFile(workDirReal, pair.audio.filePath);
    // IDENTITY, not merely containment: each half must be the very artifact
    // HLS-3 produced for that role.
    if (videoPath !== join(workDirReal, SEPARATE_VIDEO_FMP4_FILE_NAME)) throw new AppError("PROCESSING_FAILED");
    if (audioPath !== join(workDirReal, SEPARATE_AUDIO_FMP4_FILE_NAME)) throw new AppError("PROCESSING_FAILED");
    if ((await regularFileSize(videoPath)) !== pair.video.fileSize) throw new AppError("PROCESSING_FAILED");
    if ((await regularFileSize(audioPath)) !== pair.audio.fileSize) throw new AppError("PROCESSING_FAILED");
    if (controller.signal.aborted) throw stopFailure(stopped ?? "cancelled");

    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      stop("timeout");
      throw stopFailure("timeout");
    }
    const produced = await primitives.merge({
      videoPath,
      audioPath,
      workDir: workDirReal,
      target: "mp4",
      timeoutMs: remaining,
      maxOutputBytes,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw stopFailure(stopped ?? "cancelled");

    // The merge's OWN output: a contained regular MP4 that is neither half.
    if (typeof produced !== "string" || !produced.endsWith(".mp4")) throw new AppError("PROCESSING_FAILED");
    const finalPath = await assertContainedRegularFile(workDirReal, produced);
    if (finalPath === videoPath || finalPath === audioPath) throw new AppError("PROCESSING_FAILED");
    const fileSize = await regularFileSize(finalPath);
    if (fileSize <= 0) throw new AppError("PROCESSING_FAILED");
    if (fileSize > maxOutputBytes) throw new AppError("TOO_LARGE");
    if (controller.signal.aborted) throw stopFailure(stopped ?? "cancelled");
    return Object.freeze({ filePath: finalPath, container: "mp4" as const, fileSize });
  } catch (err) {
    if (stopped !== null) throw stopFailure(stopped);
    if (err instanceof AppError) throw err;
    throw new AppError("PROCESSING_FAILED");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
    controller.abort();
  }
}

export type { ClearHlsAcquisitionProgress, ClearHlsProcessedMp4 };
