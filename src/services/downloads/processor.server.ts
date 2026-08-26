import { stat } from "node:fs/promises";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { buildDownloadFilename } from "@/lib/filenames";
import { log, redactUrl } from "@/lib/logger";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { getExtractorFor } from "@/services/extractors/registry.server";
import { convertMedia } from "@/services/processing/ffmpeg.server";
import { removeJobDir } from "@/services/temp/files.server";
import { getJob, updateJob } from "@/services/jobs/store.server";
import type { JobStatusName } from "@/types/job";

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting in queue",
  analyzing: "Analyzing video...",
  downloading: "Downloading source media",
  processing: "Processing video",
  merging: "Merging audio and video",
  converting: "Converting format",
  ready: "Ready to download",
  failed: "Failed",
};

export function labelFor(status: JobStatusName, override?: string): string {
  if (override) return override;
  return STAGE_LABEL[status] ?? "Working...";
}

export async function processJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;
  updateJob(jobId, {
    status: "downloading",
    stageLabel: labelFor("downloading"),
    startedAt: Date.now(),
    progress: 0,
  });

  const started = Date.now();
  try {
    const safe = await assertSafeUrl(job.url);
    const extractor = getExtractorFor(safe.url);
    updateJob(jobId, { extractor: extractor.id });
    const result = await extractor.download(
      safe.url,
      { formatId: job.formatId },
      {
        workDir: job.workDir,
        onProgress: (update) => {
          const status = (update.stage as JobStatusName) || "downloading";
          updateJob(jobId, {
            status: status === "merging" || status === "converting" || status === "processing" ? status : "downloading",
            stageLabel: labelFor(
              status === "merging" || status === "converting" || status === "processing" ? status : "downloading",
            ),
            progress: update.progress,
            downloadedBytes: update.downloadedBytes ?? getJob(jobId)?.downloadedBytes ?? null,
            totalBytes: update.totalBytes ?? getJob(jobId)?.totalBytes ?? null,
            speed: update.speed ?? null,
            eta: update.eta ?? null,
          });
        },
      },
    );

    let filePath = result.filePath;
    let container = result.container;
    const wantsMp3 = job.formatId === "preset:mp3";
    const wantsWebm = job.formatId.endsWith("-webm");
    if (wantsMp3 && container !== "mp3") {
      updateJob(jobId, { status: "converting", stageLabel: labelFor("converting"), progress: null });
      filePath = await convertMedia({
        inputPath: filePath,
        workDir: job.workDir,
        target: "mp3",
        timeoutMs: config.downloadTimeoutMs,
      });
      container = "mp3";
    } else if (wantsWebm && container !== "webm") {
      updateJob(jobId, { status: "converting", stageLabel: labelFor("converting"), progress: null });
      filePath = await convertMedia({
        inputPath: filePath,
        workDir: job.workDir,
        target: "webm",
        timeoutMs: config.downloadTimeoutMs,
      });
      container = "webm";
    }

    const st = await stat(filePath);
    const quality =
      result.quality ||
      (job.formatId.startsWith("preset:") ? job.formatId.replace("preset:", "") : null);
    const filename = buildDownloadFilename({
      title: job.title || "video",
      quality,
      container,
    });

    updateJob(jobId, {
      status: "ready",
      stageLabel: labelFor("ready"),
      progress: 100,
      outputPath: filePath,
      outputMime: result.mime,
      filename,
      fileSize: st.size,
      quality,
      container,
      finishedAt: Date.now(),
      downloadUrl: `/api/download/${jobId}/file`,
      speed: null,
      eta: 0,
    });

    log.info("job complete", {
      jobId,
      domain: job.source,
      extractor: extractor.id,
      stage: "ready",
      durationMs: Date.now() - started,
      outputSize: st.size,
    });
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError("PROCESSING_FAILED");
    updateJob(jobId, {
      status: "failed",
      stageLabel: labelFor("failed"),
      progress: null,
      error: appErr.message,
      errorCode: appErr.code,
      finishedAt: Date.now(),
    });
    log.error("job failed", {
      jobId,
      domain: job.source,
      extractor: job.extractor,
      stage: "failed",
      durationMs: Date.now() - started,
      error: appErr.code,
      url: redactUrl(job.url),
    });
    try {
      await removeJobDir(job.workDir);
    } catch {
      // ignore
    }
  }
}
