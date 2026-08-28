import { AppError } from "@/lib/errors";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { probeDirectWorker, looksLikeDirectMedia } from "@/services/extractors/direct.server";
import { VideoMetadataSchema, WorkerAnalyzeRequestSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";

/** Test seam: lets the metadata-validation boundary be exercised directly. */
export type DirectProbeFn = (url: string, signal?: AbortSignal) => Promise<unknown>;

export async function analyzeDirectMedia(
  url: string,
  signal?: AbortSignal,
  probe: DirectProbeFn = probeDirectWorker,
): Promise<WorkerVideoMetadata> {
  const inputCheck = WorkerAnalyzeRequestSchema.safeParse({ url });
  if (!inputCheck.success) {
    throw new AppError("ANALYSIS_FAILED");
  }

  // 1 & 2: URL validation
  const { url: safeUrl } = await assertSafeUrl(inputCheck.data.url);

  // 3 & 4: direct-only, reject non-direct
  if (!looksLikeDirectMedia(safeUrl)) {
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  }

  // Direct-media path only: no generic extractor registry, no external downloader.
  try {
    const meta = await probe(safeUrl, signal);
    // 5: runtime-validate resulting metadata
    return VideoMetadataSchema.parse(meta);
  } catch (err: unknown) {
    // Cancellation must never be flattened into an analysis failure: when the
    // signal is aborted the original reason propagates verbatim, whatever
    // shape it has.
    if (signal?.aborted) throw err;
    if (err instanceof AppError) throw err;
    if ((err as { name?: unknown } | null)?.name === "AbortError") throw err;
    throw new AppError("ANALYSIS_FAILED");
  }
}
