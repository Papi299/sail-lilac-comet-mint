import { AppError } from "@/lib/errors";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { directExtractor } from "@/services/extractors/direct.server";
import { sampleExtractor } from "@/services/extractors/sample.server";
import type { MediaExtractor } from "@/services/extractors/types";
import { ytdlpExtractor } from "@/services/extractors/ytdlp.server";

const DEFAULT_EXTRACTORS: MediaExtractor[] = [sampleExtractor, directExtractor, ytdlpExtractor];
let extractors: MediaExtractor[] = DEFAULT_EXTRACTORS;

export function setExtractorsForTests(next: MediaExtractor[] | null): void {
  extractors = next ?? DEFAULT_EXTRACTORS;
}

export function listExtractors(): { id: string; name: string }[] {
  return extractors.map((e) => ({ id: e.id, name: e.name }));
}

export function getExtractorFor(url: string): MediaExtractor {
  const found = extractors.find((extractor) => extractor.canHandle(url));
  if (!found) throw new AppError("UNSUPPORTED_SITE");
  return found;
}

export async function analyzeUrl(url: string) {
  const safe = await assertSafeUrl(url);
  const extractor = getExtractorFor(safe.url);
  try {
    return { extractor: extractor.id, video: await extractor.getMetadata(safe.url) };
  } catch (err) {
    if (extractor.id === "direct") {
      try {
        const fallback = ytdlpExtractor;
        return { extractor: fallback.id, video: await fallback.getMetadata(safe.url) };
      } catch {
        throw err;
      }
    }
    throw err;
  }
}