import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { config, isYtdlpNetworkIsolated, resolveYtdlp } from "@/lib/config";
import { AppError, mapExtractorMessage } from "@/lib/errors";
import { log, redactUrl } from "@/lib/logger";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { extractDomain } from "@/lib/validation/url";
import {
  buildPresets,
  mimeForContainer,
  normalizeYtdlpFormat,
  parseYtdlpProgress,
  ytDlpFormatSelector,
  type YtdlpFormat,
} from "@/services/extractors/normalize";
import type { DownloadContext, DownloadFormatRequest, DownloadResult, MediaExtractor } from "@/services/extractors/types";
import { ffmpegAvailable } from "@/services/processing/ffmpeg.server";
import { runProcess, type RunResult } from "@/services/processing/process-runner.server";
import type { NormalizedFormat, VideoMetadata } from "@/types/media";

type YtdlpInfo = {
  title?: string;
  thumbnail?: string;
  thumbnails?: { url?: string }[];
  duration?: number;
  webpage_url?: string;
  original_url?: string;
  extractor?: string;
  extractor_key?: string;
  formats?: YtdlpFormat[];
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  format_id?: string;
};

type ProcessRunner = typeof runProcess;
let processRunner: ProcessRunner = runProcess;

export function setYtdlpProcessRunnerForTests(runner: ProcessRunner | null): void {
  processRunner = runner ?? runProcess;
}

/**
 * Fail-closed unless the operator attests that yt-dlp runs with independent
 * egress isolation. Initial URL validation is still applied when enabled;
 * it is not a substitute for that isolation.
 */
export function assertYtdlpNetworkPolicy(): void {
  if (!isYtdlpNetworkIsolated()) {
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  }
}

function ytdlpArgs(extra: string[], opts?: { quiet?: boolean }): string[] {
  const { argsPrefix } = resolveYtdlp();
  return [
    ...argsPrefix,
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--restrict-filenames",
    "--no-mtime",
    ...(opts?.quiet ? ["--no-progress"] : ["--newline"]),
    ...extra,
  ];
}

function parseJsonPayload(stdout: string): YtdlpInfo {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AppError("EXTRACTION_FAILED");
  }
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as YtdlpInfo;
  } catch {
    throw new AppError("EXTRACTION_FAILED");
  }
}

async function spawnYtdlpNetwork(opts: Parameters<ProcessRunner>[0]): Promise<RunResult> {
  assertYtdlpNetworkPolicy();
  return processRunner(opts);
}

export async function ytdlpAvailable(): Promise<boolean> {
  try {
    const { command } = resolveYtdlp();
    const result = await runProcess({
      command,
      args: ytdlpArgs(["--version"], { quiet: true }),
      timeoutMs: 10_000,
    });
    return result.code === 0 && /20\d{2}/.test(result.stdout + result.stderr);
  } catch {
    return false;
  }
}

async function dumpInfo(url: string): Promise<YtdlpInfo> {
  const { command } = resolveYtdlp();
  const result = await spawnYtdlpNetwork({
    command,
    args: ytdlpArgs(["-J", "--skip-download", url], { quiet: true }),
    timeoutMs: config.analysisTimeoutMs,
  });
  if (result.code !== 0) {
    log.warn("yt-dlp analyze failed", {
      url: redactUrl(url),
      stderr: result.stderr.slice(-800),
    });
    throw mapExtractorMessage(result.stderr || result.stdout);
  }
  return parseJsonPayload(result.stdout);
}

function formatsFromInfo(info: YtdlpInfo): NormalizedFormat[] {
  const raw = info.formats?.length ? info.formats : [];
  const normalized = raw
    .map((f) => normalizeYtdlpFormat(f))
    .filter((f): f is NormalizedFormat => f != null);

  if (normalized.length === 0 && info.format_id) {
    const fallback = normalizeYtdlpFormat({
      format_id: info.format_id,
      ext: info.ext,
      width: info.width,
      height: info.height,
      fps: info.fps,
      vcodec: info.vcodec,
      acodec: info.acodec,
      filesize: info.filesize,
      filesize_approx: info.filesize_approx,
    });
    if (fallback) normalized.push(fallback);
  }
  return normalized;
}

function metadataFromInfo(info: YtdlpInfo, url: string, mp3: boolean): VideoMetadata {
  const formats = formatsFromInfo(info);
  const thumbnail =
    info.thumbnail ||
    [...(info.thumbnails ?? [])].reverse().find((t) => t.url)?.url ||
    null;
  return {
    title: (info.title || extractDomain(url) || "Video").trim(),
    thumbnail,
    duration: typeof info.duration === "number" ? info.duration : null,
    source: extractDomain(info.webpage_url || url),
    extractor: info.extractor || info.extractor_key || "yt-dlp",
    webpageUrl: info.webpage_url || info.original_url || url,
    formats,
    presets: buildPresets(formats, { mp3 }),
    capabilities: { mp3, merge: mp3 },
  };
}

export const ytdlpExtractor: MediaExtractor = {
  id: "yt-dlp",
  name: "yt-dlp",
  canHandle(url: string) {
    return /^https?:\/\//i.test(url);
  },
  async getMetadata(url: string) {
    assertYtdlpNetworkPolicy();
    const safe = await assertSafeUrl(url);
    const mp3 = await ffmpegAvailable();
    const info = await dumpInfo(safe.url);
    const meta = metadataFromInfo(info, safe.url, mp3);
    if (!meta.formats.length && !meta.presets.length) {
      throw new AppError("EXTRACTION_FAILED");
    }
    if (meta.duration && meta.duration > config.maxVideoDuration) {
      throw new AppError("TOO_LONG");
    }
    return meta;
  },
  async getFormats(url: string) {
    const meta = await this.getMetadata(url);
    return meta.formats;
  },
  async download(url, format, ctx) {
    return downloadWithYtdlp(url, format, ctx);
  },
};

export async function downloadWithYtdlp(
  url: string,
  format: DownloadFormatRequest,
  ctx: DownloadContext,
): Promise<DownloadResult> {
  assertYtdlpNetworkPolicy();
  const safe = await assertSafeUrl(url);
  const { command } = resolveYtdlp();
  const plan = ytDlpFormatSelector(format.formatId);
  const outTemplate = join(ctx.workDir, "download.%(ext)s");
  const extra: string[] = ["-o", outTemplate, "-f", plan.selector, "--max-filesize", String(config.maxFileSize)];
  if (plan.mergeFormat) extra.push("--merge-output-format", plan.mergeFormat);
  if (plan.extractAudio) {
    extra.push("-x");
    if (plan.audioFormat) extra.push("--audio-format", plan.audioFormat, "--audio-quality", "0");
  }

  let lastProgress: number | null = 0;
  const result = await spawnYtdlpNetwork({
    command,
    args: ytdlpArgs([...extra, safe.url]),
    timeoutMs: config.downloadTimeoutMs,
    cwd: ctx.workDir,
    signal: ctx.signal,
    onStdout: (chunk) => handleProgress(chunk, ctx, (v) => {
      lastProgress = v;
    }),
    onStderr: (chunk) => handleProgress(chunk, ctx, (v) => {
      lastProgress = v;
    }),
  });

  if (result.code !== 0) {
    log.warn("yt-dlp download failed", {
      url: redactUrl(safe.url),
      stderr: result.stderr.slice(-800),
    });
    throw mapExtractorMessage(result.stderr || result.stdout);
  }

  const filePath = await findDownloadedFile(ctx.workDir);
  const st = await stat(filePath);
  if (st.size > config.maxFileSize) {
    throw new AppError("TOO_LARGE");
  }
  const ext = filePath.split(".").pop()?.toLowerCase() || "mp4";
  ctx.onProgress?.({ progress: lastProgress == null ? 100 : 100 });
  return {
    filePath,
    container: ext,
    mime: mimeForContainer(ext),
    fileSize: st.size,
    quality: plan.heightCap ? `${plan.heightCap}p` : plan.extractAudio ? "audio" : "best",
  };
}

function handleProgress(
  chunk: string,
  ctx: DownloadContext,
  setLast: (value: number | null) => void,
) {
  for (const line of chunk.split(/\r?\n/)) {
    const parsed = parseYtdlpProgress(line);
    if (!parsed) continue;
    if (parsed.progress != null) setLast(parsed.progress);
    const stage = line.includes("[Merger]")
      ? "merging"
      : line.includes("[ExtractAudio]") || line.includes("[VideoConvertor]")
        ? "converting"
        : "downloading";
    ctx.onProgress?.({
      progress: parsed.progress,
      downloadedBytes: parsed.downloadedBytes,
      totalBytes: parsed.totalBytes,
      speed: parsed.speed,
      eta: parsed.eta,
      stage,
    });
  }
}

async function findDownloadedFile(workDir: string): Promise<string> {
  const entries = await readdir(workDir);
  const files = [];
  for (const name of entries) {
    if (name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".json")) continue;
    const path = join(workDir, name);
    const st = await stat(path);
    if (st.isFile() && st.size > 0) files.push({ path, mtime: st.mtimeMs, size: st.size });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  if (!files[0]) throw new AppError("PROCESSING_FAILED");
  return files[0].path;
}
