import { AppError } from "@/lib/errors";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { probeDirectWorker, looksLikeDirectMedia } from "@/services/extractors/direct.server";
import { VideoMetadataSchema, WorkerAnalyzeRequestSchema } from "@/shared/worker/contracts";
import type { VideoMetadata } from "@/types/media";

export async function analyzeDirectMedia(url: string, signal?: AbortSignal): Promise<VideoMetadata> {
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

  // 4 & 7: Only direct-media path, no generic registry, no yt-dlp
  try {
    const meta = await probeDirectWorker(safeUrl, signal);
    // 5: runtime-validate resulting metadata
    return VideoMetadataSchema.parse(meta);
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    if (err.name === "AbortError") throw err; // let aborts bubble
    throw new AppError("ANALYSIS_FAILED");
  }
}
