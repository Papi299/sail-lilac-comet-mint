import { AppError } from "../../lib/errors.ts";
import type {
  WorkerExtractorStrategy,
  WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import type { GenericSourceSelections } from "../execution/generic-source.ts";
import { analyzeDirectMedia } from "../execution/direct-media.server.ts";
import {
  analyzeGenericMedia,
  analyzeGenericMediaInternal,
  type GenericAnalysisLimits,
} from "./ytdlp-analysis.server.ts";

/**
 * Re-exported so callers can state the analyzer's bounds without naming the
 * generic analyzer module. Everything reaches generic analysis THROUGH this
 * router, imports included.
 */
export type { GenericAnalysisLimits };

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
  /**
   * Whether the Worker's OWN FFmpeg is usable, when the caller already knows.
   *
   * Only ever consulted on the generic branch. Prefer `getFfmpegAvailable` when
   * the answer costs anything to obtain.
   */
  readonly ffmpegAvailable?: boolean;
  /**
   * CORRECTION-01. The LAZY form of `ffmpegAvailable`.
   *
   * Generic AUDIO presets from a muxed source need the Worker's own FFmpeg, so
   * the answer is a generic-ONLY input: a direct-media URL never needs it, and a
   * direct failure that forbids fallback never needs it either.
   *
   * Passing an already-resolved boolean forced the composition root to await a
   * real subprocess probe BEFORE direct analysis ran, which made every direct
   * request pay for a capability only the generic branch consults — and, worse,
   * made "direct first" false in the one place the whole phase depends on it.
   *
   * This resolver is invoked from exactly one place: inside the already-
   * authorized generic fallback branch, after direct has failed with
   * EXTRACTOR_UNAVAILABLE and after the operator's switch has been checked.
   */
  readonly getFfmpegAvailable?: () => Promise<boolean>;
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
 * The ONE direct-first routing implementation (CORRECTION-01 §4).
 *
 * `analyzeMedia` and `analyzeForExecution` differ only in what the generic
 * branch RETURNS — browser-safe metadata versus metadata plus the private
 * source selections. The decision itself must not be written twice: two copies
 * of "try direct, fall back on exactly one code, only when enabled" is exactly
 * how the HTTP surface and durable execution would drift apart.
 *
 * So the decision lives here, once, and the callers supply only the generic
 * continuation.
 *
 * Order is a security property, not a style choice:
 *
 *   1. attempt DIRECT — nothing generic has happened yet, not even a
 *      capability probe;
 *   2. on success, return immediately;
 *   3. on cancellation, propagate — an aborted analysis must never start a
 *      second, more capable network client;
 *   4. on any code other than EXTRACTOR_UNAVAILABLE, propagate;
 *   5. if the operator did not enable generic, fail closed with the same code
 *      direct produced;
 *   6. ONLY NOW resolve generic-only capability, then run generic.
 *
 * Step 6 is the correction. Resolving FFmpeg availability before step 1 made
 * every direct-media request pay for a probe it never consults, and made the
 * direct-first contract untrue in the composition root.
 */
type RoutedAnalysis<G> =
  | { readonly strategy: "direct"; readonly video: WorkerVideoMetadata }
  | { readonly strategy: "yt-dlp"; readonly generic: G };

/**
 * Everything the routing decision needs — and deliberately NOT the generic
 * analyzer seam, which each caller supplies as its own continuation. Omitting
 * it is what lets the HTTP and execution option types share one router despite
 * their generic analyzers returning different shapes.
 */
type DirectFirstRoutingOptions = Omit<MediaAnalyzerOptions, "analyzeGeneric">;

async function routeDirectFirst<G>(
  url: string,
  options: DirectFirstRoutingOptions,
  runGeneric: (opts: {
    readonly limits: GenericAnalysisLimits;
    readonly ffmpegAvailable: boolean;
    readonly signal?: AbortSignal;
  }) => Promise<G>,
): Promise<RoutedAnalysis<G>> {
  const direct = options.analyzeDirect ?? analyzeDirectMedia;

  let video: WorkerVideoMetadata;
  try {
    video = await direct(url, options.signal);
  } catch (err: unknown) {
    // Cancellation is never a strategy decision.
    if (options.signal?.aborted) throw err;

    if (!directFailureAllowsGenericFallback(err)) throw err;

    // Direct said "not my kind of URL". Generic may now be CONSIDERED — but
    // only if the operator enabled it. Disabled is fail-closed and reports the
    // same code direct produced, so a disabled deployment is indistinguishable
    // from one where no generic path exists.
    if (options.ytdlpEnabled !== true) {
      throw new AppError(GENERIC_FALLBACK_TRIGGER_CODE);
    }

    // The ONLY place generic-only capability is resolved. Everything above
    // this line has completed without it.
    const ffmpegAvailable = options.getFfmpegAvailable
      ? await options.getFfmpegAvailable()
      : (options.ffmpegAvailable ?? false);

    return {
      strategy: "yt-dlp",
      generic: await runGeneric({
        limits: options.limits,
        ffmpegAvailable,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    };
  }

  return { strategy: "direct", video };
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
  const generic =
    options.analyzeGeneric ??
    ((target: string, opts) =>
      analyzeGenericMedia(target, {
        limits: opts.limits,
        ffmpegAvailable: opts.ffmpegAvailable,
        signal: opts.signal,
      }));

  const routed = await routeDirectFirst(url, options, (opts) => generic(url, opts));
  return routed.strategy === "direct" ? routed.video : routed.generic;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION-SIDE ANALYSIS — Phase 10C3 §17
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of analyzing a URL for DURABLE EXECUTION.
 *
 * `strategy` is the Worker's own decision, reached by running the same
 * direct-first rules the HTTP path uses. It is evidence of what THIS execution
 * selected — never a browser input, and never read back from durable state
 * (§5/§42).
 *
 * `selections` is populated only on the generic path and is PRIVATE: it carries
 * the one raw upstream `format_id` per advertised preset. It must never cross
 * Worker HTTP, enter `WorkerVideoMetadata`, enter SQLite, reach Vercel or the
 * browser, be logged, or appear in an error message (§9).
 */
export type ExecutionAnalysis = {
  readonly strategy: WorkerExtractorStrategy;
  readonly video: WorkerVideoMetadata;
  readonly selections: GenericSourceSelections;
};

/** The internal generic analyzer, injectable exactly like the public one. */
export type GenericExecutionAnalyzeFn = (
  url: string,
  opts: {
    readonly limits: GenericAnalysisLimits;
    readonly ffmpegAvailable: boolean;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly video: WorkerVideoMetadata;
  readonly selections: GenericSourceSelections;
}>;

export type ExecutionAnalyzerOptions = Omit<MediaAnalyzerOptions, "analyzeGeneric"> & {
  readonly analyzeGeneric?: GenericExecutionAnalyzeFn;
};

/**
 * Analyzes one URL for durable execution, direct-first.
 *
 * Deliberately the SAME routing rules as `analyzeMedia` — `directFailureAllowsGenericFallback`
 * is the single shared decision function — so the HTTP endpoint and durable jobs
 * cannot drift onto subtly different direct-vs-generic policy (§43). The only
 * difference is what comes back: this returns the strategy it chose and, on the
 * generic path, the private source selections execution needs.
 *
 * A durable job calls this on its OWN stored URL, at execution time. It never
 * reuses the browser's earlier analysis, so a site that changed in between is
 * observed here rather than silently acquired (§17).
 */
export async function analyzeForExecution(
  url: string,
  options: ExecutionAnalyzerOptions,
): Promise<ExecutionAnalysis> {
  const generic =
    options.analyzeGeneric ??
    ((target: string, opts) =>
      analyzeGenericMediaInternal(target, {
        limits: opts.limits,
        ffmpegAvailable: opts.ffmpegAvailable,
        signal: opts.signal,
      }));

  // The SAME routing implementation the HTTP path uses. Only the generic
  // continuation differs: execution additionally keeps the private selections.
  const routed = await routeDirectFirst(url, options, (opts) => generic(url, opts));

  if (routed.strategy === "direct") {
    // Direct advertises concrete formats and needs no private selection map.
    return { strategy: "direct", video: routed.video, selections: {} };
  }
  return {
    strategy: "yt-dlp",
    video: routed.generic.video,
    selections: routed.generic.selections,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL MEDIA-ANALYSIS POLICY — Phase 10C3 §43
// ─────────────────────────────────────────────────────────────────────────────

export type MediaAnalysisPolicyConfig = {
  /** The operator's validated `YTDLP_ENABLED` intent. Fail-closed. */
  readonly ytdlpEnabled: boolean;
  readonly limits: GenericAnalysisLimits;
  /**
   * Whether the Worker's OWN FFmpeg is usable.
   *
   * A thunk rather than a boolean because it is a real subprocess probe, and
   * because it is a generic-ONLY input: only generic AUDIO presets from a muxed
   * source consult it. It is therefore invoked lazily, from inside the generic
   * fallback branch, and never on a direct-media request (CORRECTION-01 §3).
   *
   * The composition root may memoize it — the binary is installed at image
   * build time on a read-only root and cannot change while the Worker runs. The
   * defect this corrects was never the memoization; it was WHEN the memoized
   * resolver was first invoked.
   */
  readonly ffmpegAvailable: () => Promise<boolean>;
  /**
   * Test seams. Production composition passes neither, so the policy resolves
   * to the real direct and generic analyzers.
   *
   * The generic seam takes the INTERNAL shape (`{ video, selections }`) because
   * that is the single source both entry points derive from: the HTTP path
   * projects `video` out of it, exactly as `analyzeGenericMedia` does. Having
   * one seam rather than two is what keeps the public/private split from
   * needing to be re-stated here.
   */
  readonly analyzeDirect?: DirectAnalyzeFn;
  readonly analyzeGeneric?: GenericExecutionAnalyzeFn;
};

export type MediaAnalysisPolicy = {
  /** Browser-facing analysis. Returns public metadata only. */
  readonly analyze: (url: string, signal?: AbortSignal) => Promise<WorkerVideoMetadata>;
  /** Durable-execution analysis. Also returns strategy and private selections. */
  readonly analyzeForExecution: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<ExecutionAnalysis>;
};

/**
 * Builds the ONE analysis policy the whole Worker uses.
 *
 * Both entry points close over the SAME configuration and share the same
 * routing function, so `/analyze` and durable execution cannot end up with
 * subtly different direct-vs-generic behaviour — a browser that was offered a
 * generic preset must not then meet a Worker that refuses generic, and vice
 * versa (§43).
 *
 * Fail-closed by construction: `ytdlpEnabled` is a value the composition root
 * must supply from validated configuration. This module never reads the
 * environment.
 */
export function createMediaAnalysisPolicy(
  cfg: MediaAnalysisPolicyConfig,
): MediaAnalysisPolicy {
  // CORRECTION-01. The resolver is passed THROUGH, never awaited here.
  //
  // The previous form awaited `cfg.ffmpegAvailable()` while building the
  // options object, which runs BEFORE `analyzeMedia` is even entered. The
  // comment claimed the probe happened "only when the direct path has already
  // declined"; it did not. Every request on a yt-dlp-enabled deployment paid
  // for a subprocess probe that only the generic branch reads — including
  // direct-media requests, which is precisely the case direct-first exists to
  // keep cheap and unentangled.
  //
  // `getFfmpegAvailable` is invoked by the router inside the generic fallback
  // branch and nowhere else.
  const getFfmpegAvailable = cfg.ytdlpEnabled
    ? cfg.ffmpegAvailable
    : // A disabled deployment can never reach the generic branch, so it must
      // never hold a resolver that could probe. Fail-closed, and free.
      async () => false;

  const shared = (signal?: AbortSignal) => ({
    ytdlpEnabled: cfg.ytdlpEnabled,
    limits: cfg.limits,
    getFfmpegAvailable,
    ...(cfg.analyzeDirect ? { analyzeDirect: cfg.analyzeDirect } : {}),
    ...(signal ? { signal } : {}),
  });

  return {
    analyze: (url, signal) =>
      analyzeMedia(url, {
        ...shared(signal),
        // The public path projects `video` out of the internal result and drops
        // the private selections, exactly as `analyzeGenericMedia` does.
        ...(cfg.analyzeGeneric
          ? {
              analyzeGeneric: async (target: string, opts) =>
                (await cfg.analyzeGeneric!(target, opts)).video,
            }
          : {}),
      }),
    analyzeForExecution: (url, signal) =>
      analyzeForExecution(url, {
        ...shared(signal),
        ...(cfg.analyzeGeneric ? { analyzeGeneric: cfg.analyzeGeneric } : {}),
      }),
  };
}
