import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { log, redactUrl } from "@/lib/logger";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { analyzeUrl } from "@/services/extractors/registry.server";
import { processJob } from "@/services/downloads/processor.server";
import {
  averageProcessingMs,
  countActive,
  countActiveForPrincipal,
  createJob,
  createJobId,
  deleteJob,
  expiredJobs,
  getJob,
  listJobs,
  toPublicJob,
} from "@/services/jobs/store.server";
import { createJobDir, removeJobDir, tempUsage } from "@/services/temp/files.server";
import { ffmpegAvailable } from "@/services/processing/ffmpeg.server";
import { ytdlpAvailable } from "@/services/extractors/ytdlp.server";

const queue: string[] = [];
let running = 0;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupExpired();
  }, 60_000);
  cleanupTimer.unref?.();
}

export async function cleanupExpired(): Promise<number> {
  const expired = expiredJobs();
  for (const job of expired) {
    try {
      await removeJobDir(job.workDir);
    } catch {
      // ignore containment/fs errors; still drop the record
    }
    deleteJob(job.id);
  }
  return expired.length;
}

function pump() {
  while (running < config.maxConcurrentDownloads && queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    running += 1;
    void processJob(id)
      .catch(() => undefined)
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

export async function allocateJob(input: {
  url: string;
  formatId: string;
  principalId: string;
  id?: string;
  title?: string | null;
  thumbnail?: string | null;
  source?: string | null;
  extractor?: string | null;
}) {
  const id = input.id ?? createJobId();
  const workDir = await createJobDir(id);
  return createJob({
    id,
    url: input.url,
    formatId: input.formatId,
    principalId: input.principalId,
    workDir,
    title: input.title,
    thumbnail: input.thumbnail,
    source: input.source,
    extractor: input.extractor,
  });
}

export async function analyzeVideo(url: string) {
  ensureCleanup();
  const safe = await assertSafeUrl(url);
  log.info("analyze start", { url: redactUrl(safe.url) });
  const started = Date.now();
  const result = await analyzeUrl(safe.url);
  log.info("analyze complete", {
    url: redactUrl(safe.url),
    extractor: result.extractor,
    domain: result.video.source,
    durationMs: Date.now() - started,
    formats: result.video.formats.length,
  });
  if (result.video.duration && result.video.duration > config.maxVideoDuration) {
    throw new AppError("TOO_LONG");
  }
  const oversized = result.video.formats.every((f) => f.fileSize && f.fileSize > config.maxFileSize);
  if (result.video.formats.length && oversized) {
    throw new AppError("TOO_LARGE");
  }
  return result.video;
}

export async function enqueueDownload(input: {
  url: string;
  formatId: string;
  principalId: string;
  title?: string | null;
  thumbnail?: string | null;
  source?: string | null;
}) {
  ensureCleanup();
  if (countActive() >= config.maxConcurrentDownloads + 8) {
    throw new AppError("SERVER_OVERLOAD");
  }
  if (countActiveForPrincipal(input.principalId) >= config.maxConcurrentPerPrincipal) {
    throw new AppError("SERVER_OVERLOAD");
  }

  const safe = await assertSafeUrl(input.url);

  let metaTitle = input.title ?? null;
  let metaThumb = input.thumbnail ?? null;
  let metaSource = input.source ?? null;
  let extractorId: string | null = null;
  try {
    const analyzed = await analyzeUrl(safe.url);
    const video = analyzed.video;
    extractorId = analyzed.extractor;
    metaTitle = metaTitle || video.title;
    metaThumb = metaThumb || video.thumbnail;
    metaSource = metaSource || video.source;
    const allowed =
      video.presets.some((p) => p.id === input.formatId) ||
      video.formats.some((f) => f.id === input.formatId);
    if (!allowed) throw new AppError("FORMAT_UNAVAILABLE");
    if (video.duration && video.duration > config.maxVideoDuration) {
      throw new AppError("TOO_LONG");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("ANALYSIS_FAILED");
  }

  const job = await allocateJob({
    url: safe.url,
    formatId: input.formatId,
    principalId: input.principalId,
    title: metaTitle,
    thumbnail: metaThumb,
    source: metaSource,
    extractor: extractorId,
  });
  queue.push(job.id);
  log.info("job queued", {
    jobId: job.id,
    domain: metaSource,
    extractor: extractorId,
    stage: "queued",
  });
  pump();
  return toPublicJob(getJob(job.id)!);
}

export function getPublicJob(id: string) {
  const job = getJob(id);
  if (!job) return null;
  if (job.expiresAt <= Date.now()) return null;
  return toPublicJob(job);
}

export function getJobOrThrow(id: string) {
  const job = getJob(id);
  if (!job) throw new AppError("NOT_FOUND");
  if (job.expiresAt <= Date.now()) throw new AppError("EXPIRED");
  return job;
}

export async function healthSnapshot() {
  const [ffmpeg, extractor, disk] = await Promise.all([
    ffmpegAvailable(),
    ytdlpAvailable(),
    tempUsage(),
  ]);
  return {
    status: ffmpeg || extractor ? "ok" : "degraded",
    ffmpeg,
    extractor,
    activeJobs: countActive(),
    queuedJobs: queue.length,
    tempBytes: disk.bytes,
  };
}

export async function diagnosticsSnapshot() {
  const jobs = listJobs();
  const disk = await tempUsage();
  const grouped = {
    queued: jobs.filter((j) => j.status === "queued").length,
    active: jobs.filter((j) => !["queued", "ready", "failed"].includes(j.status)).length,
    completed: jobs.filter((j) => j.status === "ready").length,
    failed: jobs.filter((j) => j.status === "failed").length,
  };
  return {
    counts: grouped,
    disk,
    averageProcessingMs: averageProcessingMs(),
    worker: {
      running,
      queue: queue.length,
      maxConcurrent: config.maxConcurrentDownloads,
    },
    limits: {
      maxFileSize: config.maxFileSize,
      maxVideoDuration: config.maxVideoDuration,
      expirationMinutes: config.fileExpirationMinutes,
    },
  };
}
