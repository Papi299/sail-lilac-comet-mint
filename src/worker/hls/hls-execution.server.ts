import { AppError } from "@/lib/errors";
import {
  ClearHlsAcquisitionError,
  acquireClearHlsFmp4,
  acquireClearHlsTs,
  type ClearHlsAcquiredFmp4,
  type ClearHlsAcquiredMedia,
  type ClearHlsAcquiredTs,
  type ClearHlsAcquisitionFailure,
  type ClearHlsAcquisitionProgress,
} from "./hls-fragment-acquisition.server.ts";
import {
  ClearHlsPreflightError,
  preflightClearHlsMediaPlaylist,
  type ClearHlsAcquisitionPlan,
  type ClearHlsPreflightFailure,
} from "./hls-preflight.server.ts";
import {
  processClearHlsFmp4ToMp4,
  processClearHlsTsToMp4,
  type ClearHlsProcessedMp4,
} from "./hls-processing.server.ts";
import type { WorkerErrorCode } from "@/shared/worker/errors";

/**
 * Worker-owned CLEAR-HLS EXECUTION ORCHESTRATION (HLS-6, widened by HLS v2).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The narrow seam between the durable JobExecutor and the three clear-HLS
 * primitives. It exists so the executor never has to know a single private HLS
 * failure enum: everything below speaks `ClearHlsPreflightFailure` /
 * `ClearHlsAcquisitionFailure`, everything above speaks the existing public
 * `WorkerErrorCode` vocabulary, and this file is where the translation lives.
 *
 * Two entry points, one per durable phase, and deliberately not one:
 *
 *   downloading   `acquireSelectedClearHlsMedia()` — HLS-2 preflight, then
 *                 HLS-3 acquisition of the family the playlist declared. NO
 *                 local media work of any kind: no ffprobe, no FFmpeg, no
 *                 container inspection.
 *
 *   processing    `processAcquiredClearHlsMedia()` — HLS-4 for the family the
 *                 artifact states, and nothing else.
 *
 * ─── The segment family (HLS v2) ────────────────────────────────────────────
 *
 * The family is NOT a plan field and is not known at analysis: the public
 * analysis never fetches a media playlist. It is learned exactly once, from the
 * FRESH playlist HLS-2 fetched for this job, and it then travels only as the
 * `segmentType` of the plan and of the artifact. This module dispatches on it —
 * MPEG-TS to the unchanged v1 primitives, fMP4 to their v2 siblings — and every
 * primitive re-checks the family it was handed, so a dispatch mistake refuses
 * rather than processes.
 *
 * Keeping them apart is what makes "the processing boundary is the durable
 * `beginProcessing()` transition" enforceable. A single combined call could not
 * be placed on either side of that transition honestly.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 *   - It is not a plan derivation. It receives an already-derived plan and
 *     never chooses a rendition, a rung or a fallback.
 *   - It is not a capability decision. Since HLS-7 the ordinary planner,
 *     `deriveExecutionPlan()`, produces a `clear-hls-remux` plan for a preset
 *     the fresh analysis gave to clear HLS, and that plan arrives here. Which
 *     presets exist, and which family owns each, is decided upstream of this
 *     module and never revisited in it.
 *   - It is not a second transport or a second processing path. It adds no
 *     request of its own, no header, no cookie, no referer and no retry policy.
 *     Every byte still moves through HLS-2/HLS-3's fixed safe-HTTP profile, and
 *     every frame still moves through HLS-4's fixed stream-copy argv.
 *   - It is not an upload path. The caller's existing local-output validation
 *     and upload lifecycle remain the only ones.
 *
 * ─── Privacy ────────────────────────────────────────────────────────────────
 *
 * `plan.source.playlistUrl` is SENSITIVE: signed query parameters, expiring
 * tokens, opaque CDN identity. It is read exactly once here and handed straight
 * to HLS-2. It is never logged, never persisted, never returned, and — the
 * point of the mapping tables below — never interpolated into an `AppError`.
 * The private failure objects are DROPPED rather than wrapped as a `cause`,
 * because a transport error message can name the host it failed to reach.
 */

// ── The acquisition phase ────────────────────────────────────────────────────

/**
 * What one clear-HLS acquisition needs, and nothing more.
 *
 * `plan` is typed on the literal `"clear-hls-remux"` discriminant rather than
 * on a bare URL string. That is a TYPE statement: a progressive or split
 * execution plan cannot be handed to this seam even by mistake, exactly as the
 * two yt-dlp acquisition seams already refuse each other's plans.
 *
 * Deliberately absent: headers, cookies, an Authorization, a Referer, a user
 * agent, yt-dlp downloader options and extractor arguments. HLS-2/HLS-3's fixed
 * request profile is authoritative, and a source that needs more than it is
 * simply not supported.
 *
 * `workDir` is the server-owned per-job directory. `signal` is REQUIRED so no
 * caller can start an uncancellable acquisition. `acquisitionTimeoutMs` may
 * only NARROW HLS-3's budget; omitting it uses the application download budget,
 * which is what Production does. The preflight is not given one at all: HLS-2
 * already defaults to, and caps itself at, the application analysis budget, and
 * inventing a second policy here would be a budget this task has no evidence
 * for.
 */
export type ClearHlsAcquisitionOrder = {
  readonly plan: {
    readonly operation: "clear-hls-remux";
    readonly source: { readonly playlistUrl: string };
  };
  readonly workDir: string;
  readonly signal: AbortSignal;
  readonly acquisitionTimeoutMs?: number;
  readonly onProgress?: (progress: ClearHlsAcquisitionProgress) => void;
};

/**
 * The acquisition primitives this seam composes, injectable as ONE object: the
 * preflight, and one acquisition primitive per segment family.
 *
 * Production always uses the real set. The seam exists so a lifecycle test can
 * observe the durable job status at the EXACT instant each primitive is
 * entered — which is the principal HLS-6 invariant — without a network, a DNS
 * lookup or a filesystem write.
 */
export type ClearHlsAcquisitionPrimitives = {
  readonly preflight: typeof preflightClearHlsMediaPlaylist;
  /** MPEG-TS acquisition: the v1 primitive, under its v1 name. */
  readonly acquire: typeof acquireClearHlsTs;
  /** fMP4 acquisition (HLS v2). */
  readonly acquireFmp4: typeof acquireClearHlsFmp4;
};

const PRODUCTION_ACQUISITION_PRIMITIVES: ClearHlsAcquisitionPrimitives = {
  preflight: preflightClearHlsMediaPlaylist,
  acquire: acquireClearHlsTs,
  acquireFmp4: acquireClearHlsFmp4,
};

/**
 * HLS-2's private refusals, mapped onto the existing public Worker vocabulary.
 *
 * Exported so the mapping can be reviewed and pinned as DATA rather than read
 * out of a switch. Every member of the closed failure union has an entry, so no
 * reason can fall through to a guessed default.
 *
 *   FORMAT_UNAVAILABLE   the selected HLS source cannot satisfy the supported
 *                        format contract — a location that will not be
 *                        requested (a fragment's, or since HLS v2 an fMP4
 *                        initialization map's), a body that cannot be read, or
 *                        a playlist outside the accepted clear-VOD grammar.
 *                        `playlist_rejected` is the HLS-1 rejection vocabulary
 *                        arriving here, and HLS-1's accepted contract already
 *                        maps it this way.
 *
 *   NETWORK_ERROR        the request or the destination failed: a hop the
 *                        destination policy refused, a transport failure, or a
 *                        final status that was not 200. The private URL, the
 *                        hostname and the body never reach the AppError.
 *
 *   TIMEOUT              the one total preflight deadline expired.
 *
 *   PROCESSING_FAILED    cancellation. It is a canonical non-secret code rather
 *                        than a new one; the executor's own signal and durable
 *                        state precedence still decides the actual outcome of a
 *                        user cancellation or an operator shutdown.
 */
export const CLEAR_HLS_PREFLIGHT_ERROR_CODES: Readonly<
  Record<ClearHlsPreflightFailure, WorkerErrorCode>
> = Object.freeze({
  invalid_playlist_url: "FORMAT_UNAVAILABLE",
  playlist_encoding: "FORMAT_UNAVAILABLE",
  playlist_too_large: "FORMAT_UNAVAILABLE",
  playlist_invalid_utf8: "FORMAT_UNAVAILABLE",
  playlist_rejected: "FORMAT_UNAVAILABLE",
  fragment_url_invalid: "FORMAT_UNAVAILABLE",
  initialization_map_url_invalid: "FORMAT_UNAVAILABLE",
  destination_rejected: "NETWORK_ERROR",
  network_error: "NETWORK_ERROR",
  playlist_http_status: "NETWORK_ERROR",
  timeout: "TIMEOUT",
  cancelled: "PROCESSING_FAILED",
});

/**
 * HLS-3's private refusals, mapped the same way.
 *
 *   PROCESSING_FAILED    an internal or local structural failure —  a plan that
 *                        failed its own integrity gate, or a local aggregate
 *                        that could not be created, written or finalized. Also
 *                        cancellation, as above.
 *
 *   NETWORK_ERROR        a remote request failure.
 *
 *   FORMAT_UNAVAILABLE   the source violates the supported FRAGMENT-level v1
 *                        contract. `fragment_too_large` belongs here and NOT in
 *                        `TOO_LARGE`: it is v1's per-fragment structural
 *                        ceiling, so reporting it as the whole video exceeding
 *                        the product size limit would tell the user something
 *                        untrue about their media.
 *
 *   TOO_LARGE            `aggregate_too_large` ONLY — the delivered total would
 *                        pass the effective product ceiling, which is exactly
 *                        what that code means everywhere else.
 *
 *   TIMEOUT              the one total acquisition deadline expired.
 */
export const CLEAR_HLS_ACQUISITION_ERROR_CODES: Readonly<
  Record<ClearHlsAcquisitionFailure, WorkerErrorCode>
> = Object.freeze({
  invalid_plan: "PROCESSING_FAILED",
  output_error: "PROCESSING_FAILED",
  destination_rejected: "NETWORK_ERROR",
  network_error: "NETWORK_ERROR",
  fragment_http_status: "NETWORK_ERROR",
  fragment_encoding: "FORMAT_UNAVAILABLE",
  fragment_too_large: "FORMAT_UNAVAILABLE",
  aggregate_too_large: "TOO_LARGE",
  timeout: "TIMEOUT",
  cancelled: "PROCESSING_FAILED",
});

/**
 * Look one closed reason up in a mapping table, fail-closed.
 *
 * The tables are total over their unions, so the `hasOwnProperty` guard is for
 * a value that arrived past the type system — a forged error object carrying a
 * `reason` that is not a member. Such a value collapses to the canonical
 * internal failure instead of yielding `undefined` and becoming an AppError
 * with no code.
 */
function mappedCode<K extends string>(
  table: Readonly<Record<K, WorkerErrorCode>>,
  reason: K,
): WorkerErrorCode {
  return Object.prototype.hasOwnProperty.call(table, reason)
    ? table[reason]
    : "PROCESSING_FAILED";
}

/**
 * Anything HLS-2 threw, as a canonical `AppError` carrying the standard safe
 * message for its code.
 *
 * The original is dropped, never wrapped. A non-`ClearHlsPreflightError` is an
 * internal fault rather than a source problem, so it collapses to
 * `PROCESSING_FAILED` with its message discarded.
 */
function preflightAppError(err: unknown): AppError {
  if (err instanceof ClearHlsPreflightError) {
    return new AppError(mappedCode(CLEAR_HLS_PREFLIGHT_ERROR_CODES, err.reason));
  }
  return new AppError("PROCESSING_FAILED");
}

/** The HLS-3 counterpart, on the same terms. */
function acquisitionAppError(err: unknown): AppError {
  if (err instanceof ClearHlsAcquisitionError) {
    return new AppError(mappedCode(CLEAR_HLS_ACQUISITION_ERROR_CODES, err.reason));
  }
  return new AppError("PROCESSING_FAILED");
}

/**
 * The whole DOWNLOADING phase of a clear-HLS job: one bounded media-playlist
 * preflight, then sequential acquisition into one local aggregate of the family
 * the playlist declared — MPEG-TS fragments, or (HLS v2) an fMP4
 * initialization map followed by its fragments.
 *
 * Runs entirely while the durable job says `downloading`. It performs no local
 * media work whatsoever — this module names neither ffprobe nor FFmpeg, and
 * none of the primitives it calls spawns anything.
 *
 * The family is read from the plan HLS-2 returned — the ONE fresh playlist —
 * and the plan goes, whole and unrebuilt, to that family's primitive, which
 * re-admits it on its own terms. There is no fallback between families and no
 * second preflight: a plan that is neither family is an internal fault.
 *
 * Progress is HLS-3's own, passed straight through: truthful fragment-count
 * progress with `totalBytes`, `speed` and `eta` genuinely null, because a
 * clear-VOD playlist declares durations rather than sizes. Nothing is invented
 * here, and no progress of any kind is reported for the preflight — a playlist
 * fetch is not download progress. HLS-3's commit-point semantics already
 * guarantee no callback can arrive after it returns, so no extra latch is added
 * on top of them.
 *
 * @returns the HLS-3 artifact EXACTLY as HLS-3 froze it. This function neither
 *          rebuilds it nor copies it, so what HLS-4 later validates is the same
 *          object HLS-3 committed.
 */
export async function acquireSelectedClearHlsMedia(
  order: ClearHlsAcquisitionOrder,
  primitives: ClearHlsAcquisitionPrimitives = PRODUCTION_ACQUISITION_PRIMITIVES,
): Promise<ClearHlsAcquiredMedia> {
  const { plan, workDir, signal, acquisitionTimeoutMs, onProgress } = order;
  // The sensitive value is read ONCE, here, and the plan is not consulted again.
  const playlistUrl = plan.source.playlistUrl;

  let acquisitionPlan: ClearHlsAcquisitionPlan;
  try {
    acquisitionPlan = await primitives.preflight({ playlistUrl, signal });
  } catch (err) {
    throw preflightAppError(err);
  }

  const common = {
    workDir,
    signal,
    ...(acquisitionTimeoutMs !== undefined ? { timeoutMs: acquisitionTimeoutMs } : {}),
    ...(onProgress ? { onProgress } : {}),
  };
  try {
    switch (acquisitionPlan.segmentType) {
      case "mpegts":
        return await primitives.acquire({ plan: acquisitionPlan, ...common });
      case "fmp4":
        return await primitives.acquireFmp4({ plan: acquisitionPlan, ...common });
      default:
        // Unreachable through the type system; a plan from past it is refused
        // before any request, as an internal fault rather than a source one.
        throw new AppError("PROCESSING_FAILED");
    }
  } catch (err) {
    throw acquisitionAppError(err);
  }
}

// ── The processing phase ─────────────────────────────────────────────────────

/**
 * What one clear-HLS remux needs. Structurally HLS-4's own request, restated so
 * the executor depends on this seam rather than on the primitive directly.
 *
 * `source` must be the EXACT artifact `acquireSelectedClearHlsMedia()`
 * returned. HLS-4 independently re-validates it against the fixed HLS-3
 * artifact identity of its family, and that defence in depth is preserved
 * rather than short-circuited here.
 */
export type ClearHlsProcessingOrder = {
  readonly source: ClearHlsAcquiredMedia;
  readonly workDir: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
};

/** One HLS-4 primitive per segment family, injectable as ONE object. */
export type ClearHlsProcessingPrimitives = {
  readonly mpegts: typeof processClearHlsTsToMp4;
  readonly fmp4: typeof processClearHlsFmp4ToMp4;
};

const PRODUCTION_PROCESSING_PRIMITIVES: ClearHlsProcessingPrimitives = {
  mpegts: processClearHlsTsToMp4,
  fmp4: processClearHlsFmp4ToMp4,
};

/**
 * The whole PROCESSING phase: HLS-4's explicit ffprobe, fixed stream-copy remux
 * and output validation, for the family the acquired artifact states. Reached
 * only after the durable `beginProcessing()` transition has committed.
 *
 * There is no generic `convertMedia()` fallback, no second FFmpeg path and no
 * re-encode fallback: a transport stream or an fMP4 input that cannot be
 * copied into MP4 is a failure, not something to silently re-encode.
 *
 * The family is read from the artifact once, to choose the primitive; the
 * primitive then parses the artifact itself and refuses a family other than its
 * own, so a mismatched dispatch fails closed before any I/O.
 *
 * HLS-4 already throws the existing canonical semantics — `PROCESSING_FAILED`,
 * `TOO_LARGE`, `TIMEOUT` — and those are preserved verbatim rather than
 * reinterpreted. Only a NON-`AppError` escaping the primitive is translated,
 * and it collapses to `PROCESSING_FAILED` with its message dropped, because an
 * unexpected error's text is exactly the kind that names a path or a host.
 */
export async function processAcquiredClearHlsMedia(
  order: ClearHlsProcessingOrder,
  primitives: ClearHlsProcessingPrimitives = PRODUCTION_PROCESSING_PRIMITIVES,
): Promise<ClearHlsProcessedMp4> {
  try {
    const segmentType: unknown = (order.source as { segmentType?: unknown } | null)?.segmentType;
    switch (segmentType) {
      case "mpegts":
        return await primitives.mpegts({ ...order, source: order.source as ClearHlsAcquiredTs });
      case "fmp4":
        return await primitives.fmp4({ ...order, source: order.source as ClearHlsAcquiredFmp4 });
      default:
        throw new AppError("PROCESSING_FAILED");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("PROCESSING_FAILED");
  }
}

export type {
  ClearHlsAcquiredFmp4,
  ClearHlsAcquiredMedia,
  ClearHlsAcquiredTs,
  ClearHlsAcquisitionProgress,
  ClearHlsProcessedMp4,
};
