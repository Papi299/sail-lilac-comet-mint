import { AppError } from "@/lib/errors";
import { directExtractor } from "@/services/extractors/direct.server";
import { sampleExtractor } from "@/services/extractors/sample.server";
import type { MediaExtractor } from "@/services/extractors/types";
import { ytdlpExtractor } from "@/services/extractors/ytdlp.server";

const EXTRACTORS: MediaExtractor[] = [sampleExtractor, directExtractor, ytdlpExtractor];

export function listExtractors(): { id: string; name: string }[] {
  return EXTRACTORS.map((e) => ({ id: e.id, name: e.name }));
}

export function getExtractorFor(url: string): MediaExtractor {
  const found = EXTRACTORS.find((extractor) => extractor.canHandle(url));
  if (!found) throw new AppError("UNSUPPORTED_SITE");
  return found;
}

export async function analyzeUrl(url: string) {
  const extractor = getExtractorFor(url);
  try {
    return { extractor: extractor.id, video: await extractor.getMetadata(url) };
  } catch (err) {
    if (extractor.id === "direct") {
      try {
        const fallback = ytdlpExtractor;
        return { extractor: fallback.id, video: await fallback.getMetadata(url) };
      } catch {
        throw err;
      }
    }
    throw err;
  }
}
