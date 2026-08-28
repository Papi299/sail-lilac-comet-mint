import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { extractDomain } from "@/lib/validation/url";
import { disposeHttpBody, safeGet, safeHead } from "@/lib/security/safe-http.server";
import {
  buildPresets,
  mimeForContainer,
  normalizeCodec,
  resolutionFromHeight,
} from "@/services/extractors/normalize";
import type {
  DownloadContext,
  DownloadFormatRequest,
  DownloadResult,
  MediaExtractor,
} from "@/services/extractors/types";
import { convertMedia, ffmpegAvailable } from "@/services/processing/ffmpeg.server";
import type { NormalizedFormat, VideoMetadata } from "@/types/media";

const MEDIA_EXT = new Set([
  "mp4",
  "webm",
  "mkv",
  "mov",
  "m4v",
  "avi",
  "ogv",
  "m4a",
  "mp3",
  "ogg",
  "wav",
  "aac",
  "flac",
  "opus",
]);

function extensionFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return MEDIA_EXT.has(ext) ? ext : null;
  } catch {
    return null;
  }
}

const MEDIA_TYPES = /^(video|audio)\//;

export const directExtractor: MediaExtractor = {
  id: "direct",
  name: "Direct media",
  canHandle(url: string) {
    return Boolean(extensionFromUrl(url));
  },
  async getMetadata(url: string) {
    return _probeDirect(url);
  },
  async getFormats(url: string) {
    const meta = await _probeDirect(url);
    return meta.formats;
  },
  async download(url, format, ctx) {
    return downloadDirect(url, format, ctx);
  },
};

/**
 * Worker-side probe. Identical to the application probe except that an SSRF
 * refusal during the optional HEAD is NOT swallowed: for Worker analysis, a
 * redirect into a private address space is a hard rejection, not a missing
 * content-length. Ordinary HEAD failures stay optional.
 */
export async function probeDirectWorker(url: string, signal?: AbortSignal): Promise<VideoMetadata> {
  return _probeDirect(url, signal, { rejectUnsafeHeadRedirects: true });
}

async function _probeDirect(
  url: string,
  signal?: AbortSignal,
  opts?: { rejectUnsafeHeadRedirects?: boolean },
): Promise<VideoMetadata> {
  const ext = extensionFromUrl(url) || "mp4";
  let contentLength: number | null = null;
  let contentType: string | null = null;
  try {
    const head = await safeHead(url, { timeoutMs: Math.min(config.analysisTimeoutMs, 20_000), signal });
    contentLength = parseLen(headerString(head.headers["content-length"]));
    contentType = headerString(head.headers["content-type"]);
  } catch (err) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    if (
      opts?.rejectUnsafeHeadRedirects &&
      err instanceof AppError &&
      err.code === "INVALID_URL"
    ) {
      throw err;
    }
    // HEAD is optional; do not fetch the body during analyze, and never
    // pass a remote URL to FFmpeg.
  }

  const type = (contentType || "").toLowerCase();
  const hasVideo = !["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"].includes(ext) && !type.startsWith("audio/");
  const hasAudio = true;
  const format: NormalizedFormat = {
    id: "direct-original",
    resolution: hasVideo ? resolutionFromHeight(null) : "audio",
    width: null,
    height: null,
    fps: null,
    container: ext,
    videoCodec: hasVideo ? normalizeCodec(null) : null,
    audioCodec: hasAudio ? normalizeCodec(null) : null,
    bitrate: null,
    fileSize: contentLength,
    hasVideo,
    hasAudio,
    formatNote: contentType,
  };

  const mp3 = await ffmpegAvailable(signal);
  const title = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Video");
  return {
    title: title.replace(/\.[a-z0-9]+$/i, "") || "Video",
    thumbnail: null,
    duration: null,
    source: extractDomain(url),
    extractor: "direct",
    webpageUrl: url,
    formats: [format],
    presets: buildPresets([format], { mp3, ffmpeg: mp3 }),
    capabilities: { mp3, merge: mp3 },
  };
}

/**
 * §5: Worker-safe original-media download primitive.
 *
 * Downloads the ORIGINAL direct media byte stream over the existing hardened,
 * SSRF-pinned `safeGet` path and returns the local artifact plus the trusted
 * source-derived metadata. It deliberately accepts NO formatId and NO
 * preferredContainer, and it never runs FFmpeg or any conversion: Worker
 * Phase-6 requires that all local processing happen strictly after the durable
 * job has transitioned into `processing`.
 */
export async function downloadDirectOriginalWorker(
  url: string,
  ctx: DownloadContext,
): Promise<{ filePath: string; container: string; mime: string; fileSize: number }> {
  const ext = extensionFromUrl(url) || "bin";
  const dest = join(ctx.workDir, `source.${ext}`);
  await streamDownload(url, dest, ctx);
  const st = await stat(dest);
  if (st.size > config.maxFileSize) throw new AppError("TOO_LARGE");
  return {
    filePath: dest,
    container: ext,
    mime: mimeForContainer(ext),
    fileSize: st.size,
  };
}

async function downloadDirect(
  url: string,
  format: DownloadFormatRequest,
  ctx: DownloadContext,
): Promise<DownloadResult> {
  const ext = extensionFromUrl(url) || "bin";
  const dest = join(ctx.workDir, `source.${ext}`);
  await streamDownload(url, dest, ctx);
  const st = await stat(dest);
  if (st.size > config.maxFileSize) throw new AppError("TOO_LARGE");

  let filePath = dest;
  let container = ext;
  if (format.formatId === "preset:mp3" || format.convertMp3) {
    ctx.onProgress?.({ progress: null, stage: "converting" });
    filePath = await convertMedia({
      inputPath: dest,
      workDir: ctx.workDir,
      target: "mp3",
      timeoutMs: config.downloadTimeoutMs,
      signal: ctx.signal,
    });
    container = "mp3";
  } else if (format.preferredContainer && format.preferredContainer !== ext) {
    const target = format.preferredContainer === "webm" ? "webm" : "mp4";
    ctx.onProgress?.({ progress: null, stage: "converting" });
    filePath = await convertMedia({
      inputPath: dest,
      workDir: ctx.workDir,
      target,
      timeoutMs: config.downloadTimeoutMs,
      signal: ctx.signal,
    });
    container = target;
  }

  const outStat = await stat(filePath);
  return {
    filePath,
    container,
    mime: mimeForContainer(container),
    fileSize: outStat.size,
    quality: format.formatId.startsWith("preset:") ? format.formatId.replace("preset:", "") : "original",
  };
}

async function streamDownload(url: string, dest: string, ctx: DownloadContext) {
  const res = await safeGet(url, {
    signal: ctx.signal,
    timeoutMs: config.downloadTimeoutMs,
  });
  if (res.status === 404) {
    disposeHttpBody(res.body);
    throw new AppError("VIDEO_UNAVAILABLE");
  }
  if (res.status < 200 || res.status >= 300 || !res.body) {
    disposeHttpBody(res.body);
    throw new AppError("NETWORK_ERROR");
  }
  const type = headerString(res.headers["content-type"]) || "";
  if (type.startsWith("text/html")) {
    disposeHttpBody(res.body);
    throw new AppError("EXTRACTION_FAILED");
  }
  const total = parseLen(headerString(res.headers["content-length"]));
  let downloaded = 0;
  const started = Date.now();
  const nodeReadable = res.body as Readable;
  nodeReadable.on("data", (chunk: Buffer | string) => {
    const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    downloaded += length;
    if (downloaded > config.maxFileSize) {
      nodeReadable.destroy(new AppError("TOO_LARGE"));
      return;
    }
    const elapsed = (Date.now() - started) / 1000;
    const speed = elapsed > 0 ? downloaded / elapsed : null;
    const progress = total ? Math.min(99, Math.round((downloaded / total) * 100)) : null;
    const eta = speed && total ? Math.max(0, (total - downloaded) / speed) : null;
    ctx.onProgress?.({
      progress,
      downloadedBytes: downloaded,
      totalBytes: total,
      speed,
      eta,
      stage: "downloading",
    });
  });
  await pipeline(nodeReadable, createWriteStream(dest));
}

function headerString(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function parseLen(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function looksLikeDirectMedia(url: string): boolean {
  return Boolean(extensionFromUrl(url));
}

export { MEDIA_TYPES };
