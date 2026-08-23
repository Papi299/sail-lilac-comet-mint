import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { extractDomain } from "@/lib/validation/url";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
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
import { convertMedia, ffmpegAvailable, probeFromFfmpegOutput } from "@/services/processing/ffmpeg.server";
import { runProcess } from "@/services/processing/process-runner.server";
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
    return probeDirect(url);
  },
  async getFormats(url: string) {
    const meta = await probeDirect(url);
    return meta.formats;
  },
  async download(url, format, ctx) {
    return downloadDirect(url, format, ctx);
  },
};

async function probeDirect(url: string): Promise<VideoMetadata> {
  const ext = extensionFromUrl(url) || "mp4";
  let contentLength: number | null = null;
  let contentType: string | null = null;
  try {
    const head = await fetchFollow(url, "HEAD");
    contentLength = parseLen(head.headers.get("content-length"));
    contentType = head.headers.get("content-type");
  } catch {
    // HEAD is optional; continue with GET-range / ffmpeg probe.
  }

  let probe = {
    duration: null as number | null,
    width: null as number | null,
    height: null as number | null,
    fps: null as number | null,
    videoCodec: null as string | null,
    audioCodec: null as string | null,
    container: ext,
  };

  try {
    const result = await runProcess({
      command: config.ffmpegPath,
      args: ["-nostdin", "-hide_banner", "-i", url],
      timeoutMs: Math.min(config.analysisTimeoutMs, 20_000),
    });
    const probed = probeFromFfmpegOutput(result.stderr + result.stdout);
    probe = {
      ...probe,
      ...probed,
      container: probed.container || probe.container,
    };
  } catch {
    // ffmpeg probe is best-effort
  }

  const hasVideo = Boolean(probe.videoCodec) || !["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"].includes(ext);
  const hasAudio = Boolean(probe.audioCodec) || true;
  const format: NormalizedFormat = {
    id: "direct-original",
    resolution: hasVideo ? resolutionFromHeight(probe.height) : "audio",
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    container: ext,
    videoCodec: hasVideo ? normalizeCodec(probe.videoCodec) : null,
    audioCodec: hasAudio ? normalizeCodec(probe.audioCodec) : null,
    bitrate: null,
    fileSize: contentLength,
    hasVideo,
    hasAudio,
    formatNote: contentType,
  };

  const mp3 = await ffmpegAvailable();
  const title = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Video");
  return {
    title: title.replace(/\.[a-z0-9]+$/i, "") || "Video",
    thumbnail: null,
    duration: probe.duration,
    source: extractDomain(url),
    extractor: "direct",
    webpageUrl: url,
    formats: [format],
    presets: buildPresets([format], { mp3 }),
    capabilities: { mp3, merge: mp3 },
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
  let current = url;
  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    await assertSafeUrl(current);
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: ctx.signal,
      headers: {
        "User-Agent": "VideoFetch/1.0",
        Accept: "video/*,audio/*,*/*;q=0.8",
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new AppError("NETWORK_ERROR");
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok || !res.body) {
      throw new AppError(res.status === 404 ? "VIDEO_UNAVAILABLE" : "NETWORK_ERROR");
    }
    const type = res.headers.get("content-type") || "";
    if (type.startsWith("text/html")) {
      throw new AppError("EXTRACTION_FAILED");
    }
    const total = parseLen(res.headers.get("content-length"));
    let downloaded = 0;
    const started = Date.now();
    const nodeReadable = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    nodeReadable.on("data", (chunk: Buffer) => {
      downloaded += chunk.length;
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
    return;
  }
  throw new AppError("NETWORK_ERROR");
}

async function fetchFollow(url: string, method: "HEAD" | "GET"): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    await assertSafeUrl(current);
    const res = await fetch(current, {
      method,
      redirect: "manual",
      headers: { "User-Agent": "VideoFetch/1.0" },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new AppError("NETWORK_ERROR");
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new AppError("NETWORK_ERROR");
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
