import { lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  assertContainedRegularFile,
  assertWorkDirRealPath,
  hasExactStreamShape,
  probeLocalMedia,
  regularFileSize,
} from "@/services/processing/ffprobe.server";
import { runProcess } from "@/services/processing/process-runner.server";
import type { WorkspaceFootprint } from "../execution/workspace-capacity.ts";
import {
  AGGREGATE_FILE_NAME as HLS_ACQUIRED_TS_FILE_NAME,
  type ClearHlsAcquiredTs,
} from "./hls-fragment-acquisition.server.ts";

/**
 * Worker-owned CLEAR-HLS v1 LOCAL PROCESSING (HLS-4).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The component that turns the raw MPEG-TS artifact HLS-3 acquired into a
 * validated MP4, by STREAM COPY only. It validates the input before anything
 * is spawned, probes it with an explicit MPEG-TS demuxer, remuxes it with one
 * fixed FFmpeg command, and then proves the produced MP4 is what it claims to
 * be — independently of FFmpeg's exit status.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 * It is not a transport component. It opens no socket, resolves no name, reads
 * no URL and never sees a playlist: HLS-3 owns acquisition and HLS-4 is handed
 * only the local artifact it produced. It is not a transcoder either — no
 * encoder is named anywhere and there is no fallback that would re-encode
 * media the user did not ask to be re-encoded.
 *
 * It is not orchestration. It does not move a durable job between states, does
 * not upload, and does not decide when it runs. Future HLS-6 work will call it
 * strictly AFTER `beginProcessing()` commits.
 *
 * ─── The lifecycle invariant it exists to protect ───────────────────────────
 *
 *   downloading  = network acquisition only
 *   processing   = Worker-owned local media processing
 *   uploading    = object-storage transfer
 *   ready        = completed durable result
 *
 * No FFmpeg or ffprobe work may happen while a durable job is still
 * `downloading`. Keeping acquisition (HLS-3) and processing (HLS-4) in
 * separate modules, with the artifact as the only thing crossing between them,
 * is what makes that boundary structural rather than a convention.
 *
 * ─── Dormancy ───────────────────────────────────────────────────────────────
 *
 * Nothing in Production calls this module. HLS remains unadvertised and
 * unselectable: the analyzer's protocol policy is untouched, so `m3u8_native`
 * is still withheld as `unsupported_protocol`, there is no HLS preset, no
 * JobExecutor path and no upload integration. This is foundation only, and
 * implementing the source foundation is NOT a Product capability.
 */

// ── The processed artifact ───────────────────────────────────────────────────

/**
 * What a successful processing run produced.
 *
 * `container` is stated rather than inferred: the returned file is an MP4
 * because the fixed argv named the `mp4` MUXER and the finalized artifact was
 * re-probed as ISO-BMFF, not because its name ends in `.mp4`. `fileSize` is
 * measured from disk after finalization, never taken from FFmpeg.
 */
export type ClearHlsProcessedMp4 = {
  readonly filePath: string;
  readonly container: "mp4";
  readonly fileSize: number;
};

/**
 * The whole input surface.
 *
 * Deliberately absent: a URL, a playlist, a media title, a codec string, a
 * yt-dlp format id, an output name, a container choice, an FFmpeg option and
 * any browser-supplied value. The only caller-supplied strings are the
 * server-owned job `workDir` and the `filePath` inside the HLS-3 artifact, and
 * the second of those is checked against a fixed application-owned identity
 * before it is allowed anywhere near a subprocess.
 *
 * `signal` is REQUIRED so no caller can start uncancellable processing.
 * `timeoutMs` is the ONE budget for the whole primitive. `maxOutputBytes` is
 * the Product delivered-media ceiling this call must respect.
 */
export type ClearHlsProcessingRequest = {
  readonly source: ClearHlsAcquiredTs;
  readonly workDir: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
};

// ── Fixed artifact names ─────────────────────────────────────────────────────

/**
 * The finished MP4, and the partial it is renamed from.
 *
 * Module constants, exactly as in HLS-3. Neither name comes from upstream
 * media, from a URL, from the browser or from a caller argument, and neither
 * is ever given an arbitrary extension. The `.part` suffix is not what decides
 * the container either — the argv names the `mp4` muxer explicitly, so FFmpeg
 * never infers a format from the filename it is writing.
 */
export const HLS_OUTPUT_FILE_NAME = "hls-output.mp4";
export const HLS_OUTPUT_PARTIAL_FILE_NAME = "hls-output.mp4.part";

// ── The approved clear-HLS v1 stream shape ───────────────────────────────────

/**
 * The ONLY MPEG-TS shape HLS v1 will process: exactly one video stream and
 * exactly one audio stream, and nothing else at all.
 *
 * This is a deliberate consequence of HLS v1 having no audio pairing. A clear
 * VOD media playlist that v1 accepts is a SELF-CONTAINED muxed rendition, so
 * the artifact must carry both halves itself. Accepting a video-only MPEG-TS
 * would mean silently delivering a silent video from an adaptive video-only
 * playlist, and accepting an audio-only one would mean delivering no picture;
 * accepting several of either would mean guessing which the user wanted.
 *
 * So ambiguity is refused rather than resolved. There is no "first useful
 * stream" selection anywhere in this module, and `parseProbeDocument()`
 * already refuses subtitle, data, attachment and unknown stream kinds outright
 * before the count is even examined.
 */
export const HLS_V1_TS_STREAM_SHAPE = Object.freeze({
  family: "mpegts",
  video: 1,
  audio: 1,
} as const);

/** The MP4 side of the same rule, applied to the artifact this module produces. */
export const HLS_V1_MP4_STREAM_SHAPE = Object.freeze({
  family: "iso-bmff",
  video: 1,
  audio: 1,
} as const);

// ── Workspace footprint ──────────────────────────────────────────────────────

/**
 * What HLS v1 processing costs the media workspace, in units of the Product
 * `maxFileSizeBytes` ceiling.
 *
 * During a successful remux the acquired MPEG-TS and the produced MP4 coexist:
 * HLS-3 bounds the source at the Product ceiling and this module bounds the
 * output at the same ceiling, so the peak is `2 ×` — 8,589,934,592 bytes at the
 * 4 GiB default. That is the same footprint `convert`, `extract-*` and
 * `merge-split` already have, which is why `STARTUP_WORKSPACE_FOOTPRINT` is
 * already sufficient for it.
 *
 * It is stated HERE rather than in `workspaceFootprintForPlan()` on purpose.
 * That switch is exhaustive over the operations a Product execution plan can
 * actually carry, and HLS has no such operation: inventing one so the switch
 * could return 2 would put a non-executable operation into a closed Product
 * vocabulary purely to satisfy an arithmetic lookup. HLS-6/HLS-7 will decide
 * how a real HLS plan joins that policy. Until then the requirement lives with
 * the primitive that has it, and the arithmetic stays single-sourced in
 * `requiredWorkspaceBytes()`.
 *
 * The type annotation is load-bearing: it is a compile error for this to drift
 * outside the closed `WorkspaceFootprint` union the capacity policy accepts.
 * The import is type-only, so no runtime edge is created from the dormant HLS
 * foundation into `worker/execution`.
 */
export const HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT: WorkspaceFootprint = 2;

// ── Subprocess output ceilings ───────────────────────────────────────────────

/**
 * HARD ceilings for the remux subprocess. At `-v error` a successful
 * stream-copy remux is silent, so these bound a failure mode rather than
 * normal operation. Nothing retained under them is ever returned, parsed or
 * surfaced: the exit code is the whole report. The probe stages carry the
 * ffprobe primitive's own tighter ceilings.
 */
const REMUX_MAX_STDOUT_BYTES = 64_000;
const REMUX_MAX_STDERR_BYTES = 256_000;

// ── The processing budget ────────────────────────────────────────────────────

/**
 * The monotonic clock the budget is measured on.
 *
 * `performance.now()` rather than `Date.now()`: a wall-clock step (NTP, a
 * container resume) must not hand a stage a budget that never expires, nor
 * expire one that has barely started. It is the same clock the rest of the
 * repository already uses when it needs elapsed time.
 */
function monotonicNowMs(): number {
  return performance.now();
}

/**
 * The budget REMAINING before an absolute deadline, as a positive whole number
 * of milliseconds, or `null` when the deadline has already passed.
 *
 * Pure and exported so the arithmetic is reviewable without a subprocess. Every
 * stage of the primitive is granted this value and nothing else, which is
 * exactly what stops probe + remux + probe + probe from becoming four
 * independent full processing windows: the deadline is computed once, at entry,
 * and no stage ever re-derives it from its own start time.
 *
 * Floored to an integer because both `probeLocalMedia()` and the process runner
 * require a positive safe integer timeout.
 */
export function remainingBudgetMs(deadlineMs: number, nowMs: number): number | null {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return null;
  const remaining = Math.floor(deadlineMs - nowMs);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) return null;
  return remaining;
}

// ── Input authority ──────────────────────────────────────────────────────────

/**
 * The module-owned SNAPSHOT of an acquired artifact.
 *
 * Structurally identical to HLS-3's `ClearHlsAcquiredTs`, and deliberately a
 * distinct type: holding one of these means holding values this module already
 * captured and validated, not a reference to an object supplied by a caller.
 */
export type ValidatedClearHlsAcquiredTs = {
  readonly filePath: string;
  readonly segmentType: "mpegts";
  readonly fileSize: number;
};

/** The three fields HLS-3's frozen result carries, and the only three. */
const ACQUIRED_TS_FIELDS = ["filePath", "segmentType", "fileSize"] as const;

/**
 * PARSE an acquired artifact into a validated snapshot, or refuse it.
 *
 * Defence in depth before ANY filesystem work and long before any spawn. An
 * object reaching here should always be one `acquireClearHlsTs()` froze, so
 * this is not a second acquisition policy — it is a structural gate that
 * refuses a forged, mutated or hand-built object outright.
 *
 * ─── Why this PARSES rather than answering yes/no ───────────────────────────
 *
 * A boolean type guard validates the values it read and then hands the CALLER
 * back the original object, which the caller must read again to use. That is
 * only sound if a second read is guaranteed to return what the first one did,
 * and on a JavaScript object it is not: `Object.freeze` makes accessor
 * properties non-configurable but does NOT convert them into data properties,
 * so a frozen object may still expose a getter that answers differently every
 * time. Validating one getter result and then acting on another is a
 * TOCTOU-shaped hole, and no amount of care at the call site closes it.
 *
 * So this function returns the CAPTURED PRIMITIVES instead. Past the call, the
 * caller holds three strings and numbers of its own and the supplied object is
 * never consulted again — there is nothing left for a getter to answer.
 *
 * ─── The representation it requires ─────────────────────────────────────────
 *
 * Exactly what `acquireClearHlsTs()` actually constructs, which is a frozen
 * object literal:
 *
 *   - a non-null object, frozen;
 *   - the ordinary `Object.prototype`, so a null-prototype object, a class
 *     instance and a Proxy-backed exotic shape are all refused rather than
 *     probed;
 *   - an own property set of EXACTLY the three fields. Counted with
 *     `Reflect.ownKeys()`, not `Object.keys()`: the latter sees only
 *     enumerable STRING keys, so a symbol-keyed or non-enumerable extra would
 *     sail past a `length === 3` check while the object still carried payload
 *     this module has not reasoned about;
 *   - each of the three an own DATA property. An accessor is refused outright,
 *     and note that refusing it never invokes it —
 *     `Object.getOwnPropertyDescriptor()` reports a getter without calling it,
 *     so a hostile getter gets no execution at all;
 *   - inherited substitutes are refused by the same exact-own-set rule: a
 *     value supplied through the prototype is not an own property and cannot
 *     satisfy it.
 *
 * Only then are the three captured values themselves checked, and the returned
 * snapshot is frozen so the caller cannot mutate what it validated either.
 */
export function parseAcquiredTsArtifact(value: unknown): ValidatedClearHlsAcquiredTs | null {
  if (typeof value !== "object" || value === null) return null;
  if (!Object.isFrozen(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;

  // The COMPLETE own-property set: strings and symbols, enumerable or not.
  if (Reflect.ownKeys(value).length !== ACQUIRED_TS_FIELDS.length) return null;

  const captured: Record<string, unknown> = {};
  for (const field of ACQUIRED_TS_FIELDS) {
    // An OWN descriptor, so an inherited value can never stand in for one.
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined) return null;
    // A data descriptor carries `value`; an accessor descriptor carries
    // `get`/`set` instead. This is the single read of the stored value, and
    // there is no second one.
    if (!("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  // Three own descriptors were found and the own set has exactly three
  // members, so the set is exactly these three fields.

  const { filePath, segmentType, fileSize } = captured;
  if (segmentType !== "mpegts") return null;
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  if (typeof fileSize !== "number") return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;

  return Object.freeze({ filePath, segmentType: "mpegts" as const, fileSize });
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

/**
 * Whether ANY directory entry exists at `path` — a file, a directory, or a
 * symlink, dangling or not.
 *
 * `lstat` rather than `stat` or `access`, so a dangling symlink counts as
 * PRESENT instead of looking like free space. FFmpeg's file protocol follows
 * symlinks, so an output name occupied by `hls-output.mp4 -> /elsewhere` would
 * otherwise be written THROUGH rather than refused.
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

/** Best-effort removal. A path that is already gone is the desired state. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already absent, or the directory refuses the removal; either way there
    // is nothing further this module can do about it.
  }
}

// ── The remux command ────────────────────────────────────────────────────────

/**
 * The exact remux argv. Pure and exported so an argv-policy test can pin every
 * security-relevant flag without spawning anything.
 *
 * Fixed. There is no path by which a caller, a playlist, a source, a codec
 * string or a browser value can add, remove or reorder an argument: the only
 * two variable slots are the two application-owned absolute paths, both of
 * which are `<workDir>/<module constant>` and both of which have already been
 * proven contained.
 *
 * ─── Why this is a remux and not a transcode ────────────────────────────────
 *
 * `-c:v copy -c:a copy` names no encoder at all, and there is no fallback that
 * would introduce one. A TS whose streams cannot be copied into MP4 makes
 * FFmpeg exit non-zero, and that is reported as a failure rather than quietly
 * re-encoded into media the user never asked for.
 *
 * ─── The bitstream-filter question ──────────────────────────────────────────
 *
 * H.264 lives in MPEG-TS as Annex B and in MP4 as AVCC, which is the classic
 * reason a TS → MP4 copy is thought to need `-bsf:v h264_mp4toannexb` or its
 * inverse. It does not need one HERE, and that is not an assumption: this exact
 * argv was run offline against ffprobe/ffmpeg 5.1.9-0+deb12u1 — the version the
 * Worker image pins — on a real muxed H.264 + AAC transport stream, and it
 * exited 0 and produced an MP4 that re-probes as ISO-BMFF with exactly one
 * video and one audio stream. The pinned muxer performs the framing conversion
 * itself, which is a container concern and not a re-encode; no filter is named
 * in the argv, so nothing here can silently become a transcode. If a future
 * pinned runtime ever does require an application-owned filter, that is a
 * change to be evidenced and pinned, never guessed.
 */
export function buildClearHlsRemuxArgs(opts: {
  sourcePath: string;
  outputPath: string;
}): string[] {
  return [
    // NEVER overwrite. The primitive refuses an existing output entry before
    // spawning; `-n` makes FFmpeg refuse one that appeared between that check
    // and FFmpeg's own existence check, instead of truncating it. `-y` is
    // deliberately absent. Verified in the pinned runtime: a second run over an
    // existing output exits 1 with "File 'out.mp4' already exists. Exiting."
    // and leaves the file byte-for-byte unchanged.
    "-n",
    "-nostdin",
    // Diagnostics only, and bounded. A successful stream copy is silent.
    "-v",
    "error",

    // Local file access ONLY, as a per-input demuxer option. This is the
    // control that stops a crafted local container from inducing a SECONDARY
    // network fetch — path validation cannot catch that, because the path
    // handed to FFmpeg really is local; it is the file's CONTENTS that would
    // name the remote resource. Verified in the pinned runtime: an http input
    // under this whitelist fails with "Protocol 'http' not on whitelist
    // 'file'!" before any DNS lookup.
    "-protocol_whitelist",
    "file",
    // Explicit demuxer. The input is NEVER auto-detected: a `.ts` suffix is not
    // evidence of anything, and letting FFmpeg probe an attacker-shaped local
    // file into some unrelated demuxer is exactly the hazard this avoids.
    // Verified in the pinned runtime: `-f mpegts` on a real MP4 exits 1.
    "-f",
    "mpegts",
    "-i",
    opts.sourcePath,

    // Explicit stream mapping — never FFmpeg's default stream selection, which
    // picks by its own heuristics. The approved shape has exactly one of each,
    // and the probe has already refused anything else, so these two maps
    // address the whole of the media rather than a chosen subset of it.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",

    // STREAM COPY ONLY.
    "-c:v",
    "copy",
    "-c:a",
    "copy",

    // The artifact needs video and audio, not upstream metadata. Whatever the
    // transport stream carried — titles, service names, chapter markers — is
    // dropped rather than carried into a file the user downloads.
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",

    // ISO-BMFF only, and verified compatible with this exact stream-copy
    // command in the pinned runtime.
    "-movflags",
    "+faststart",

    // Fixed output MUXER. The container is chosen here, not inferred from the
    // output filename — which is why writing to a `.part` name is safe.
    "-f",
    "mp4",
    opts.outputPath,
  ];
}

// ── The finalization barrier ─────────────────────────────────────────────────

/**
 * The points inside finalization where a stop may land: while the final
 * no-clobber check is in flight, while the rename is in flight, and while the
 * final validation is in flight.
 */
export type ProcessingFinalizationStep = "before-rename" | "after-rename" | "before-return";

/**
 * A test-only barrier, inert in Production.
 *
 * Finalization is a handful of short filesystem awaits, and a cancellation or a
 * deadline landing inside any of them must still stop the processing. Proving
 * that with wall-clock timing would be luck rather than a test, so this module
 * offers the smallest seam that makes it deterministic — the same seam HLS-3
 * uses, for the same reason: a module-private hook a test can use to hold one
 * await open, stop the operation, and release it.
 *
 * It is not a production abstraction. Nothing in Production imports this module
 * at all, so no production caller can reach the setter, and while the barrier
 * is null the finalization path is byte-for-byte what it would be without the
 * seam.
 */
let finalizationBarrier: ((step: ProcessingFinalizationStep) => Promise<void>) | null = null;

/** Install or clear the barrier. Passing null restores the production path. */
export function setClearHlsProcessingBarrierForTests(
  barrier: ((step: ProcessingFinalizationStep) => Promise<void>) | null,
): void {
  finalizationBarrier = barrier;
}

/** Nothing at all unless a test installed a barrier. */
function atFinalizationStep(step: ProcessingFinalizationStep): Promise<void> | void {
  if (finalizationBarrier === null) return;
  return finalizationBarrier(step);
}

// ── Stop causes ──────────────────────────────────────────────────────────────

type StopCause = "cancelled" | "timeout";

/** The canonical failure each stop cause maps onto. No new error code exists. */
function stopFailure(cause: StopCause): AppError {
  return cause === "timeout"
    ? new AppError("TIMEOUT")
    : new AppError("PROCESSING_FAILED", "Download was cancelled.");
}

// ── The processing primitive ─────────────────────────────────────────────────

/**
 * Validate one acquired MPEG-TS artifact and remux it, by stream copy, into a
 * validated MP4 inside the same job work directory.
 *
 * Lifecycle:
 *
 *    1. validate the request bounds, and PARSE the supplied artifact into a
 *       validated snapshot, before ANY I/O — past that point the caller's
 *       object is never read again;
 *    2. resolve the real work directory and prove the source is a contained,
 *       regular, non-symlink file at the FIXED HLS-3 artifact location;
 *    3. prove the on-disk size equals the artifact's declared `fileSize`;
 *    4. require both output names to be free;
 *    5. probe the source through an explicit MPEG-TS demuxer and require the
 *       approved one-video + one-audio shape;
 *    6. stream-copy it to the partial output with one fixed FFmpeg command;
 *    7. validate the produced partial: contained, regular, non-empty, within
 *       the Product ceiling, and an ISO-BMFF file of the approved shape;
 *    8. re-check the final name is free, then rename the partial onto it;
 *    9. REVALIDATE the finalized artifact from scratch — containment, type,
 *       size and container shape — and only then return a frozen result.
 *
 * On ANY failure the artifacts THIS call created are removed, so a failed call
 * never leaves a successful-looking `hls-output.mp4` behind. Entries that were
 * already there when the call started are never deleted and never overwritten:
 * a stale or foreign output is evidence of unexpected workspace state, and
 * refusing is fail-closed where "helpfully" removing it would be a guess.
 *
 * Deadline and cancellation: ONE absolute budget covers the whole primitive.
 * Every subprocess stage is granted only the budget REMAINING, so four stages
 * can never become four full windows, and one operation-owned controller
 * carries whichever stop arrives FIRST — the caller's cancellation or the
 * deadline — into every subprocess, where the process runner kills the owned
 * POSIX process group. The first cause is latched, so a later failure caused by
 * the stop cannot overwrite it, and the caller's own `AbortSignal.reason` is
 * never read or surfaced. Every await in finalization is followed by a stop
 * gate, so a call whose caller cancelled, or whose deadline expired, while a
 * filesystem operation was in flight cannot still return success.
 *
 * Nothing about FFmpeg's or ffprobe's output survives a failure. The exit code
 * is the whole report, and the errors this function throws are the existing
 * canonical ones — `PROCESSING_FAILED`, `TOO_LARGE`, `TIMEOUT` — with no local
 * path, upstream URL, hostname, source title, codec text, signal reason or
 * subprocess diagnostic in them.
 */
export async function processClearHlsTsToMp4(
  request: ClearHlsProcessingRequest,
): Promise<ClearHlsProcessedMp4> {
  // Destructuring is itself a snapshot: every request field is read exactly
  // once here and only the locals are used afterwards.
  const { workDir, timeoutMs, maxOutputBytes, signal } = request;

  // Nothing starts for a caller that has already gone: no probe, no FFmpeg and
  // no filesystem work at all.
  if (signal.aborted) throw stopFailure("cancelled");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  // THE PARSING BOUNDARY. `request.source` is read exactly once, right here,
  // and every later mention of `source` is this module's own validated
  // snapshot. The supplied object is never consulted again.
  const source = parseAcquiredTsArtifact(request.source);
  if (source === null) throw new AppError("PROCESSING_FAILED");

  const deadlineMs = monotonicNowMs() + timeoutMs;

  let stopped: StopCause | null = null;
  const controller = new AbortController();
  const stop = (cause: StopCause) => {
    if (stopped !== null) return;
    stopped = cause;
    controller.abort();
  };
  const onCallerAbort = () => stop("cancelled");
  signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);

  /**
   * Detach from everything that could still stop this call. Idempotent: it runs
   * once at the commit point and again in the `finally`, and both `clearTimeout`
   * on a cleared timer and `removeEventListener` for a listener that is already
   * gone are no-ops.
   */
  const disarmStopSources = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
  };

  /**
   * The budget this stage may use, or a refusal.
   *
   * Derived from the ONE deadline computed at entry. A stage that would start
   * with nothing left does not start at all.
   */
  const stageBudgetMs = (): number => {
    const remaining = remainingBudgetMs(deadlineMs, monotonicNowMs());
    if (remaining === null) {
      stop("timeout");
      throw stopFailure("timeout");
    }
    return remaining;
  };

  /**
   * The stop gate placed after every await that is not itself cancellable.
   *
   * Checks the operation-owned controller, never the caller's signal reason.
   */
  const assertStillRunning = (): void => {
    if (controller.signal.aborted) throw stopFailure(stopped ?? "cancelled");
    stageBudgetMs();
  };

  /**
   * Map anything thrown onto the existing canonical semantics.
   *
   * Once the caller or the deadline has stopped the call, whatever the
   * interrupted operation reported afterwards is a CONSEQUENCE, not the cause,
   * so the latched first cause wins. Otherwise a canonical `AppError` — the
   * `TOO_LARGE` this module raises, or the `TIMEOUT` the process runner raises
   * when a stage's own budget expires — is passed through unchanged, and
   * anything else at all becomes `PROCESSING_FAILED`. The original error is
   * DROPPED rather than wrapped: an errno message carries a filesystem path.
   */
  const classify = (err: unknown): AppError => {
    if (stopped !== null) return stopFailure(stopped);
    if (err instanceof AppError) return err;
    return new AppError("PROCESSING_FAILED");
  };

  // Only an artifact THIS call created may be removed by it.
  let owned: string | null = null;
  try {
    // ── 2. The source must be the HLS-3 artifact, not merely a local file ───
    //
    // `assertWorkDirRealPath` proves the work directory exists and is a
    // directory, and resolves it so every later comparison is between REAL
    // locations rather than spellings. `assertContainedRegularFile` then proves
    // the named entry is physically inside it and is a regular file: a URL, a
    // protocol-relative reference, a relative path, an escaping symlink, an
    // in-directory symlink, a directory, a FIFO, a socket and a device are all
    // refused there, before anything is spawned.
    const workDirReal = await assertWorkDirRealPath(workDir);
    const sourcePath = await assertContainedRegularFile(workDirReal, source.filePath);

    // ...and IDENTITY, which containment alone does not give. Some other
    // regular file the job happens to have written is not the artifact HLS-3
    // produced, and processing it would mean remuxing media this pipeline never
    // acquired. The expected location is the shared HLS-3 constant joined onto
    // the real work directory.
    const expectedSourcePath = join(workDirReal, HLS_ACQUIRED_TS_FILE_NAME);
    if (sourcePath !== expectedSourcePath) throw new AppError("PROCESSING_FAILED");

    // ── 3. The declared size must be the real size ─────────────────────────
    //
    // A mismatch means the artifact snapshot and the bytes on disk disagree,
    // so one of them is stale or forged; neither is safe to process. The
    // comparison is against the CAPTURED size, not a fresh read of the
    // caller's object.
    const sourceSize = await regularFileSize(sourcePath);
    if (sourceSize <= 0) throw new AppError("PROCESSING_FAILED");
    if (sourceSize !== source.fileSize) throw new AppError("PROCESSING_FAILED");

    // ── 4. Both output names must be free ──────────────────────────────────
    const partialPath = join(workDirReal, HLS_OUTPUT_PARTIAL_FILE_NAME);
    const outputPath = join(workDirReal, HLS_OUTPUT_FILE_NAME);
    // The three names are distinct module constants, so this can only fail if
    // one of them were ever edited into collision. Cheap, and it fails closed.
    if (partialPath === sourcePath || outputPath === sourcePath) {
      throw new AppError("PROCESSING_FAILED");
    }
    if (await pathEntryExists(partialPath)) throw new AppError("PROCESSING_FAILED");
    if (await pathEntryExists(outputPath)) throw new AppError("PROCESSING_FAILED");
    assertStillRunning();

    // ── 5. The source's stream shape ───────────────────────────────────────
    const sourceProbe = await probeLocalMedia({
      inputPath: sourcePath,
      workDir: workDirReal,
      family: HLS_V1_TS_STREAM_SHAPE.family,
      timeoutMs: stageBudgetMs(),
      signal: controller.signal,
    });
    if (!hasExactStreamShape(sourceProbe, HLS_V1_TS_STREAM_SHAPE)) {
      throw new AppError("PROCESSING_FAILED");
    }

    // ── 6. The remux ───────────────────────────────────────────────────────
    //
    // The partial becomes THIS call's the moment FFmpeg may create it, so a
    // failure from here on removes it. The work directory is private to one
    // job, so the no-clobber check above is the whole ownership guarantee; `-n`
    // is what covers the window between that check and FFmpeg's own open.
    const budget = stageBudgetMs();
    owned = partialPath;
    const remux = await runProcess({
      command: config.ffmpegPath,
      args: buildClearHlsRemuxArgs({ sourcePath, outputPath: partialPath }),
      timeoutMs: budget,
      cwd: workDirReal,
      signal: controller.signal,
      maxStdoutBytes: REMUX_MAX_STDOUT_BYTES,
      maxStderrBytes: REMUX_MAX_STDERR_BYTES,
    });
    // No raw FFmpeg stderr reaches the AppError; the exit code is the whole
    // report. A non-zero exit includes `-n` having refused a racing entry.
    if (remux.code !== 0) throw new AppError("PROCESSING_FAILED");
    assertStillRunning();

    // ── 7. The produced partial is validated, not assumed ───────────────────
    //
    // FFmpeg exiting zero is not by itself proof that the file on disk is a
    // contained, bounded, correctly shaped MP4 — and it is certainly not proof
    // that the entry at that name is still a regular file.
    const producedPath = await assertContainedRegularFile(workDirReal, partialPath);
    if (producedPath !== partialPath) throw new AppError("PROCESSING_FAILED");
    const producedSize = await regularFileSize(producedPath);
    if (producedSize <= 0) throw new AppError("PROCESSING_FAILED");
    // The Product delivered-media ceiling, enforced on the ARTIFACT. Workspace
    // capacity is an operational allowance for temporary files and is never
    // evidence that a delivered file satisfies this policy.
    if (producedSize > maxOutputBytes) throw new AppError("TOO_LARGE");

    const producedProbe = await probeLocalMedia({
      inputPath: producedPath,
      workDir: workDirReal,
      family: HLS_V1_MP4_STREAM_SHAPE.family,
      timeoutMs: stageBudgetMs(),
      signal: controller.signal,
    });
    if (!hasExactStreamShape(producedProbe, HLS_V1_MP4_STREAM_SHAPE)) {
      throw new AppError("PROCESSING_FAILED");
    }

    // ── 8. Finalization ────────────────────────────────────────────────────
    //
    // A private single-flight workDir, so this immediate no-clobber check is
    // the whole guarantee: it is not a claim of resistance against another
    // process racing the rename on a hostile filesystem.
    assertStillRunning();
    if (await pathEntryExists(outputPath)) throw new AppError("PROCESSING_FAILED");

    await atFinalizationStep("before-rename");
    assertStillRunning();
    try {
      await rename(partialPath, outputPath);
    } catch {
      throw new AppError("PROCESSING_FAILED");
    }
    // The final name belongs to this call from the instant the rename succeeds,
    // so a stop arriving from here on removes it rather than leaving a
    // successful-looking artifact behind for a call that failed.
    owned = outputPath;
    await atFinalizationStep("after-rename");
    assertStillRunning();

    // ── 9. Revalidate the FINALIZED artifact ───────────────────────────────
    //
    // From scratch, at the final path, because the rename is a separate moment
    // from everything that was proven about the partial.
    const finalPath = await assertContainedRegularFile(workDirReal, outputPath);
    if (finalPath !== outputPath) throw new AppError("PROCESSING_FAILED");
    const fileSize = await regularFileSize(finalPath);
    if (fileSize <= 0) throw new AppError("PROCESSING_FAILED");
    if (fileSize > maxOutputBytes) throw new AppError("TOO_LARGE");

    const finalProbe = await probeLocalMedia({
      inputPath: finalPath,
      workDir: workDirReal,
      family: HLS_V1_MP4_STREAM_SHAPE.family,
      timeoutMs: stageBudgetMs(),
      signal: controller.signal,
    });
    if (!hasExactStreamShape(finalProbe, HLS_V1_MP4_STREAM_SHAPE)) {
      throw new AppError("PROCESSING_FAILED");
    }

    // The LAST await of the primitive, and the last gate. Nothing asynchronous
    // may follow it: the frozen result is built synchronously, so no stop can
    // land between this check and the return.
    await atFinalizationStep("before-return");
    assertStillRunning();

    // ── THE COMMIT POINT ────────────────────────────────────────────────────
    //
    // Everything that defines a successful processing run has now happened, so
    // the call detaches from its external stop sources. Past this line nothing
    // can turn the finished artifact back into a failure.
    disarmStopSources();
    return Object.freeze({
      filePath: finalPath,
      container: "mp4" as const,
      fileSize,
    });
  } catch (err) {
    const failure = classify(err);
    if (owned !== null) await removeQuietly(owned);
    throw failure;
  } finally {
    disarmStopSources();
    controller.abort();
  }
}
