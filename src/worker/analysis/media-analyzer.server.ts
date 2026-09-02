import { AppError } from "../../lib/errors.ts";
import type { WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { analyzeDirectMedia } from "../execution/direct-media.server.ts";
import {
  analyzeGenericMedia,
  type GenericAnalysisLimits,
} from "./ytdlp-analysis.server.ts";

/**
 * Worker-owned media analysis STRATEGY ROUTER (Phase 10C2).
 *
 * This is the function that a later, separately authorized phase will install
 * as `WorkerService`'s analyzer. Today nothing in Production composition calls
 * it: `WorkerService` still defaults to `analyzeDirectMedia`, `JobExecutor`
 * has no generic branch, and `/api/analyze` is unchanged. It exists here so the
 * routing rules can be reviewed and tested in isolation BEFORE they become
 * reachable.
 *
 * ─── The rule ───────────────────────────────────────────────────────────────
 *
 *   1. Always try direct first.
 *   2. Direct succeeds                       -> return direct metadata verbatim.
 *   3. Direct fails with EXTRACTOR_UNAVAILABLE and generic is ENABLED
 *                                            -> try the generic analyzer.
 *   4. Direct fails with EXTRACTOR_UNAVAILABLE and generic is DISABLED
 *                                            -> EXTRACTOR_UNAVAILABLE.
 *   5. Anything else                         -> propagate unchanged, no fallback.
 *
 * ─── Why the fallback condition is exactly one code ─────────────────────────
 *
 * `EXTRACTOR_UNAVAILABLE` is the ONLY direct outcome that means "this URL is
 * not a direct media file, so a different strategy might apply". Every other
 * failure carries information that a second attempt would destroy:
 *
 *   INVALID_URL        the Worker's own SSRF/URL validation refused the input.
 *                      Retrying through yt-dlp would take a URL the security
 *                      boundary just rejected and hand it to a second, far more
 *                      capable network client. This is the case that matters
 *                      most.
 *   NETWORK_ERROR      the source was reachable-but-failing, or DNS resolution
 *                      itself was refused. Not a strategy mismatch.
 *   TIMEOUT            the analysis budget is already spent; a second network
 *                      path would exceed it.
 *   TOO_LARGE/TOO_LONG a media bound was already enforced against real data.
 *                      A second opinion could only weaken it.
 *   VIDEO_UNAVAILABLE  the source answered authoritatively.
 *   ANALYSIS_FAILED /
 *   EXTRACTION_FAILED /
 *   PROCESSING_FAILED  direct analysis genuinely failed on a URL it DID accept
 *                      as direct media. That is not a missing extractor.
 *
 * An unexpected non-`AppError` exception is likewise never a fallback trigger.
 * A crash of unknown origin is the weakest possible evidence that a second
 * network path is safe to start, so it propagates.
 */

/** Direct analysis, injectable so the router can be tested without a network. */
export type DirectAnalyzeFn = (
  url: string,
  signal?: AbortSignal,
) => Promise<WorkerVideoMetadata>;

/** Generic analysis, injectable for the same reason. */
export type GenericAnalyzeFn = (
  url: string,
  opts: {
    readonly limits: GenericAnalysisLimits;
    readonly ffmpegAvailable: boolean;
    readonly signal?: AbortSignal;
  },
) => Promise<WorkerVideoMetadata>;

export type MediaAnalyzerOptions = {
  /**
   * The operator's explicit `YTDLP_ENABLED` intent, supplied by the composition
   * root. Fail-closed: absent means disabled.
   *
   * This is an APPLICATION feature switch, not a claim that generic execution
   * is safe. In Production the boundary that actually constrains yt-dlp's
   * networking is the external media namespace and its nftables policy.
   */
  readonly ytdlpEnabled?: boolean;
  readonly limits: GenericAnalysisLimits;
  readonly ffmpegAvailable?: boolean;
  readonly signal?: AbortSignal;
  /** Test seams. Production would use the real analyzers. */
  readonly analyzeDirect?: DirectAnalyzeFn;
  readonly analyzeGeneric?: GenericAnalyzeFn;
};

/** The single canonical code that permits a generic second attempt. */
export const GENERIC_FALLBACK_TRIGGER_CODE = "EXTRACTOR_UNAVAILABLE" as const;

/**
 * Decides whether a direct failure permits the generic path.
 *
 * Exported so the decision itself — not merely its consequences — can be
 * exhaustively tested against every Worker error code.
 */
export function directFailureAllowsGenericFallback(err: unknown): boolean {
  return err instanceof AppError && err.code === GENERIC_FALLBACK_TRIGGER_CODE;
}

/**
 * Analyzes one submitted URL, direct-media first.
 *
 * On the generic path this returns metadata whose `extractor` is exactly
 * `"yt-dlp"`; on the direct path it returns the direct analyzer's own result
 * completely unmodified, `extractor: "direct"` included. Direct's format and
 * preset semantics are not reshaped to resemble generic's — the two contracts
 * stay independent.
 */
export async function analyzeMedia(
  url: string,
  options: MediaAnalyzerOptions,
): Promise<WorkerVideoMetadata> {
  const direct = options.analyzeDirect ?? analyzeDirectMedia;
  const generic =
    options.analyzeGeneric ??
    ((target: string, opts) =>
      analyzeGenericMedia(target, {
        limits: opts.limits,
        ffmpegAvailable: opts.ffmpegAvailable,
        signal: opts.signal,
      }));

  try {
    return await direct(url, options.signal);
  } catch (err: unknown) {
    // Cancellation is never a strategy decision. An aborted analysis must not
    // silently start a second, more capable network client.
    if (options.signal?.aborted) throw err;

    if (!directFailureAllowsGenericFallback(err)) throw err;

    // Direct said "not my kind of URL". Generic may now be CONSIDERED — but
    // only if the operator enabled it. Disabled is fail-closed and reports the
    // same code direct produced, so a disabled deployment is indistinguishable
    // from one where no generic path exists.
    if (options.ytdlpEnabled !== true) {
      throw new AppError(GENERIC_FALLBACK_TRIGGER_CODE);
    }

    return await generic(url, {
      limits: options.limits,
      ffmpegAvailable: options.ffmpegAvailable ?? false,
      signal: options.signal,
    });
  }
}
