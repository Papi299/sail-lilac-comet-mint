import { createReadStream } from "node:fs";
import { buildDownloadFilename } from "@/lib/filenames";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
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
    let workDir = "";
    try {
      workDir = await createJobDir(jobId);
    } catch {
      this.store.failJob(jobId, "PROCESSING_FAILED", ERROR_MESSAGES.PROCESSING_FAILED);
      return;
    }
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
      // diagnostics safely removed
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
      // eslint-disable-next-line no-control-regex
      title: meta.title.substring(0, 1024).replace(/[\u0000-\u001F]/g, ""),
      thumbnail: meta.thumbnail || null,
      // eslint-disable-next-line no-control-regex
      source: meta.source.substring(0, 2048).replace(/[\u0000-\u001F]/g, ""),
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
        try {
          const now = this.getClock();
          if (now - lastProgressTime >= throttleMs || p.progress === 100 || p.progress === null) {
            lastProgressTime = now;
            const progress = p.progress != null && Number.isFinite(p.progress) ? p.progress : null;
            const downloadedBytes = p.downloadedBytes != null && Number.isInteger(p.downloadedBytes) && p.downloadedBytes >= 0 ? p.downloadedBytes : null;
            const totalBytes = p.totalBytes != null && Number.isInteger(p.totalBytes) && p.totalBytes >= 0 ? p.totalBytes : null;
            const speed = p.speed != null && Number.isFinite(p.speed) && p.speed >= 0 ? p.speed : null;
            const eta = p.eta != null && Number.isFinite(p.eta) && p.eta >= 0 ? p.eta : null;
            
            const upRes = this.store.updateExecutionProgress(jobId, "downloading", {
              progress,
              downloadedBytes,
              totalBytes,
              speed,
              eta,
              // eslint-disable-next-line no-control-regex
              stageLabel: (p.stage || "Downloading").substring(0, 255).replace(/[\u0000-\u001F\u007F]/g, ""),
            });
            if (upRes.type !== "updated") {
              this.activeControllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED"));
            }
          }
        } catch {
          this.activeControllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED"));
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
        const stream = createReadStream(validOut.path);
    
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

    if (readyResult.type === "storage_failure") { // storage failure
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
    } catch { /* ignore */ }
  }
}
