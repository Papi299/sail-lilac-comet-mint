import { createReadStream } from "node:fs";
import { buildDownloadFilename } from "@/lib/filenames";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { config } from "@/lib/config";
import { createJobDir, removeJobDir } from "@/services/temp/files.server";
import { analyzeDirectMedia } from "./direct-media.server.ts";
import { directExtractor } from "@/services/extractors/direct.server";
import { validateLocalOutput } from "./local-output.server.ts";
import type { WorkerJobStore } from "@/worker/state/job-store";
import type { ObjectStoreWriter } from "@/worker/storage/writer";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import { WorkerErrorCodeSchema } from "@/shared/worker/errors";
import { finalizeJobUpload } from "@/worker/storage/upload-lifecycle.server";

export class JobExecutor {
  private readonly store: WorkerJobStore;
  private readonly writer: ObjectStoreWriter;
  private readonly getClock: () => number;
  private readonly activeControllers: Map<string, AbortController>;

  constructor(
    store: WorkerJobStore,
    writer: ObjectStoreWriter,
    getClock: () => number = () => Date.now(),
    activeControllers: Map<string, AbortController> = new Map()
  ) {
    this.store = store;
    this.writer = writer;
    this.getClock = getClock;
    this.activeControllers = activeControllers;
  }

  public cancel(jobId: string): import("@/worker/state/job-store").CancelJobResult {
    const res = this.store.cancelJob(jobId);
    if (res.type === "cancelled") {
      this.activeControllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
    }
    return res;
  }

  public async execute(job: DurableWorkerJob): Promise<void> {
    const jobId = job.jobId;
    const workDir = await createJobDir(jobId);
    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);
    const signal = controller.signal;

    // Register-before-work race fix: check if we are already cancelled
    const currentView = this.store.getJob(jobId);
    if (!currentView || currentView.status === "cancelled" || currentView.status === "failed") {
      this.activeControllers.delete(jobId);
      await this.cleanup(workDir);
      return;
    }

    try {
      await this.runWorkflow(job, workDir, signal);
    } catch (err: any) {
      if (signal.aborted) {
        // cancellation is not failure
        const view = this.store.getJob(jobId);
        if (view && view.status === "cancelled") {
          return; // terminal cancellation winner
        }
      }

      let code = "PROCESSING_FAILED";
      const parsed = WorkerErrorCodeSchema.safeParse(err.code);
      if (parsed.success) {
        code = parsed.data;
      }
      if (err instanceof AppError && err.code) {
        const parsed2 = WorkerErrorCodeSchema.safeParse(err.code);
        if (parsed2.success) code = parsed2.data;
      }
      const safeMsg = ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES] || ERROR_MESSAGES.PROCESSING_FAILED;
      console.error("Executor caught error:", err);
      this.store.failJob(jobId, code, safeMsg);
    } finally {
      this.activeControllers.delete(jobId);
      await this.cleanup(workDir);
    }
  }

  private async runWorkflow(job: DurableWorkerJob, workDir: string, signal: AbortSignal) {
    const jobId = job.jobId;

    // Check expiry
    this.checkExpiry(job);

    // 1. analyzing -> downloading
    const meta = await analyzeDirectMedia(job.url, signal);
    
    // Check format
    const formatReq = job.formatId.startsWith("preset:") 
      ? meta.presets.find(p => p.id === job.formatId)
      : meta.formats.find(f => f.id === job.formatId);
      
    if (!formatReq) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }

    const analysisRes = this.store.completeAnalysis(jobId, {
      title: meta.title.substring(0, 1024).replace(/[\x00-\x1F]/g, ""),
      thumbnail: meta.thumbnail || null,
      source: meta.source.substring(0, 2048).replace(/[\x00-\x1F]/g, ""),
      extractor: "direct",
    });
    if (analysisRes.type !== "updated") return;

    this.checkExpiry(job);

    // 2. download -> processing
    let lastProgressTime = 0;
    const throttleMs = 250; // max ~4 updates/sec

    const dlResult = await directExtractor.download(job.url, { formatId: job.formatId }, {
      workDir,
      signal,
      onProgress: (p) => {
        const now = this.getClock();
        if (now - lastProgressTime >= throttleMs || p.progress === 100 || p.progress === null) {
          lastProgressTime = now;
          const upRes = this.store.updateExecutionProgress(jobId, "downloading", {
            progress: p.progress,
            downloadedBytes: p.downloadedBytes ?? null,
            totalBytes: p.totalBytes ?? null,
            speed: p.speed ?? null,
            eta: p.eta ?? null,
            stageLabel: (p.stage || "Downloading").substring(0, 255).replace(/[\x00-\x1F]/g, ""),
          });
          if (upRes.type !== "updated") {
            controller.abort();
          }
        }
      }
    });

    const procRes = this.store.beginProcessing(jobId);
    if (procRes.type !== "updated") return;

    // 3. validate local output
    this.checkExpiry(job);
    const validOut = await validateLocalOutput(workDir, dlResult.filePath);

    // 4. processing -> uploading
    const upRes2 = this.store.beginUploading(jobId);
    if (upRes2.type !== "updated") return;

    // 5. upload
    this.checkExpiry(job);
    
    // get stream directly
        const stream = createReadStream(dlResult.filePath);
    
    // We import buildDownloadFilename locally or reimplement safe equivalent
    const filename = buildDownloadFilename({ title: meta.title, quality: dlResult.quality, container: dlResult.container });

    const readyResult = await finalizeJobUpload({
      jobId,
      store: this.store,
      writer: this.writer,
      body: stream,
      filename,
      fileSize: validOut.size,
      mime: dlResult.mime,
      quality: dlResult.quality || null,
      container: dlResult.container,
    });

    if (readyResult.type === "storage_failure") { console.error("storage_failure:", readyResult);
      throw new AppError("PROCESSING_FAILED");
    }
  }

  private checkExpiry(job: DurableWorkerJob) {
    if (this.getClock() >= job.expiresAt) {
      throw new AppError("EXPIRED");
    }
  }

  private buildSafeFilename(title: string, container: string): string {
    const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\u00A0-\uFFFF]/g, "_").replace(/_+/g, "_").substring(0, 100);
    return `${cleanTitle || "video"}.${container}`;
  }

  private async cleanup(workDir: string) {
    try {
      await removeJobDir(workDir);
    } catch {}
  }
}
