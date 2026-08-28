import { createReadStream } from "node:fs";
import { buildDownloadFilename } from "@/lib/filenames";
import { config } from "@/lib/config";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { createJobDir, removeJobDir } from "@/services/temp/files.server";
import { analyzeDirectMedia } from "./direct-media.server.ts";
import { downloadDirectOriginalWorker } from "@/services/extractors/direct.server";
import { mimeForContainer } from "@/services/extractors/normalize";
import { convertMedia } from "@/services/processing/ffmpeg.server";
import { validateLocalOutput } from "./local-output.server.ts";
import {
  deriveDirectExecutionPlan,
  type DirectExecutionPlan,
} from "./format-plan.ts";
import type { CancelJobResult, DurableWorkerJob, WorkerJobStore } from "@/worker/state/job-store";
import type { ObjectStoreWriter } from "@/worker/storage/writer";
import type { WorkerVideoMetadata } from "@/shared/worker/contracts";
import { WorkerErrorCodeSchema } from "@/shared/worker/errors";
import { finalizeJobUpload } from "@/worker/storage/upload-lifecycle.server";

/** Minimum wall-clock gap between two durable progress writes (§21). */
export const PROGRESS_THROTTLE_MS = 250;

/** Analysis is dependency-injected so tests can drive it without live network. */
export type AnalyzeDirectMediaFn = (
  url: string,
  signal?: AbortSignal,
) => Promise<WorkerVideoMetadata>;

export type OriginalDownloadResult = {
  filePath: string;
  container: string;
  mime: string;
  fileSize: number;
};

/**
 * §5: downloads the ORIGINAL direct artifact only. It must never convert, and
 * it never receives a formatId or a preferred container.
 */
export type DownloadOriginalFn = (
  url: string,
  ctx: {
    workDir: string;
    signal?: AbortSignal;
    onProgress?: (update: {
      progress: number | null;
      downloadedBytes?: number | null;
      totalBytes?: number | null;
      speed?: number | null;
      eta?: number | null;
      stage?: string;
    }) => void;
  },
) => Promise<OriginalDownloadResult>;

/**
 * §12: local processing is dependency-injected so acceptance tests can observe
 * the durable job status at the exact moment FFmpeg would be invoked.
 */
export type LocalProcessingFn = (opts: {
  inputPath: string;
  workDir: string;
  target: "mp4" | "webm" | "mp3" | "m4a";
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<string>;

export type JobExecutorDeps = {
  analyze?: AnalyzeDirectMediaFn;
  downloadOriginal?: DownloadOriginalFn;
  processLocally?: LocalProcessingFn;
};

/**
 * Strips every ASCII control character (U+0000–U+001F and U+007F) and clamps
 * length before anything reaches durable state. The store schemas reject the
 * same characters independently — this is defence in depth, not the sole
 * trust boundary (§16).
 */
function sanitizeForDurableState(value: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, maxLength);
}

export class JobExecutor {
  private readonly store: WorkerJobStore;
  private readonly writer: ObjectStoreWriter;
  private readonly getClock: () => number;
  private readonly activeControllers: Map<string, AbortController>;
  private readonly analyze: AnalyzeDirectMediaFn;
  private readonly downloadOriginal: DownloadOriginalFn;
  private readonly processLocally: LocalProcessingFn;

  constructor(
    store: WorkerJobStore,
    writer: ObjectStoreWriter,
    getClock: () => number = () => Date.now(),
    activeControllers: Map<string, AbortController> = new Map(),
    deps: JobExecutorDeps = {},
  ) {
    this.store = store;
    this.writer = writer;
    this.getClock = getClock;
    this.activeControllers = activeControllers;
    this.analyze = deps.analyze ?? analyzeDirectMedia;
    this.downloadOriginal = deps.downloadOriginal ?? downloadDirectOriginalWorker;
    this.processLocally = deps.processLocally ?? convertMedia;
  }

  public cancel(jobId: string): CancelJobResult {
    const res = this.store.cancelJob(jobId);
    if (res.type === "cancelled") {
      this.activeControllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
    }
    return res;
  }

  public async execute(job: DurableWorkerJob): Promise<void> {
    const jobId = job.jobId;

    // §18: the AbortController is registered BEFORE any filesystem or media
    // setup, so a cancellation landing between the claim and the work is
    // observed deterministically instead of racing createJobDir().
    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);
    const signal = controller.signal;

    let workDir = "";
    try {
      const currentView = this.store.getJob(jobId);
      if (
        !currentView ||
        currentView.status === "cancelled" ||
        currentView.status === "failed" ||
        currentView.status === "ready"
      ) {
        return;
      }
      if (signal.aborted) {
        return;
      }

      try {
        workDir = await createJobDir(jobId);
      } catch {
        this.store.failJob(jobId, "PROCESSING_FAILED", ERROR_MESSAGES.PROCESSING_FAILED);
        return;
      }

      await this.runWorkflow(job, workDir, signal);
    } catch (err: unknown) {
      if (signal.aborted) {
        // Cancellation is not a failure: if cancel won the durable CAS, the
        // terminal state it wrote must be preserved verbatim.
        const view = this.store.getJob(jobId);
        if (view && view.status === "cancelled") {
          return;
        }
      }

      const code = this.classifyErrorCode(err);
      const safeMsg = ERROR_MESSAGES[code];
      // §27: the raw error is deliberately never logged and never persisted.
      this.store.failJob(jobId, code, safeMsg);
    } finally {
      this.activeControllers.delete(jobId);
      if (workDir) {
        await this.cleanup(workDir);
      }
    }
  }

  private classifyErrorCode(err: unknown): (typeof WorkerErrorCodeSchema)["_output"] {
    const raw = (err as { code?: unknown } | null)?.code;
    const parsed = WorkerErrorCodeSchema.safeParse(raw);
    return parsed.success ? parsed.data : "PROCESSING_FAILED";
  }

  private async runWorkflow(job: DurableWorkerJob, workDir: string, signal: AbortSignal) {
    const jobId = job.jobId;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // ── analyzing ────────────────────────────────────────────────────────────
    const meta = await this.analyze(job.url, signal);

    // §8: locate the exact selected item and derive the explicit execution plan
    // from trusted, runtime-validated metadata before any state advances.
    const plan = deriveDirectExecutionPlan(meta, job.formatId);

    const analysisRes = this.store.completeAnalysis(jobId, {
      title: sanitizeForDurableState(meta.title, 1024) || "Video",
      thumbnail: meta.thumbnail || null,
      source: sanitizeForDurableState(meta.source, 2048) || "unknown",
      extractor: "direct",
    });
    if (analysisRes.type !== "updated") return;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // ── downloading: ORIGINAL BYTES ONLY ─────────────────────────────────────
    // §4: no FFmpeg work of any kind may start while the durable job says
    // `downloading`. This call cannot convert — it takes no format at all.
    const original = await this.downloadOriginal(job.url, {
      workDir,
      signal,
      onProgress: this.makeProgressReporter(jobId),
    });

    // ── processing ───────────────────────────────────────────────────────────
    const procRes = this.store.beginProcessing(jobId);
    if (procRes.type !== "updated") return;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // §11: local processing happens strictly AFTER beginProcessing() committed.
    const producedPath = await this.executePlan(plan, original, workDir, signal);

    const validOut = await validateLocalOutput(workDir, producedPath);

    // ── uploading ────────────────────────────────────────────────────────────
    const upRes = this.store.beginUploading(jobId);
    if (upRes.type !== "updated") return;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // §10: the container, MIME and filename extension all come from the plan's
    // single allowlisted target, so the advertised preset and the produced
    // artifact cannot diverge.
    const container = plan.targetContainer;
    const quality = plan.requestedFormatId.startsWith("preset:")
      ? plan.requestedFormatId.slice("preset:".length)
      : "original";
    const filename = buildDownloadFilename({ title: meta.title, quality, container });

    // The canonical, containment-validated path is the exact path opened.
    const stream = createReadStream(validOut.path);

    const readyResult = await finalizeJobUpload({
      jobId,
      store: this.store,
      writer: this.writer,
      body: stream,
      filename,
      fileSize: validOut.size,
      mime: mimeForContainer(container),
      quality,
      container,
    });

    if (readyResult.type === "storage_failure") {
      throw new AppError("PROCESSING_FAILED");
    }
    // `job_state_conflict` means another writer already committed a terminal
    // state (cancelled / failed / ready). finalizeJobUpload has deleted the
    // uploaded object; the terminal winner is left exactly as it is.
  }

  /**
   * §9 + §10: executes exactly the derived plan. `plan.targetContainer` is a
   * closed union, so no user-supplied string ever becomes an FFmpeg target,
   * an output extension, or a path segment.
   */
  private async executePlan(
    plan: DirectExecutionPlan,
    original: OriginalDownloadResult,
    workDir: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (plan.operation === "keep-original") {
      if (original.container !== plan.targetContainer) {
        throw new AppError("FORMAT_UNAVAILABLE");
      }
      return original.filePath;
    }

    const target = plan.targetContainer;
    const produced = await this.processLocally({
      inputPath: original.filePath,
      workDir,
      target,
      timeoutMs: config.downloadTimeoutMs,
      signal,
    });

    if (!produced.endsWith(`.${target}`)) {
      throw new AppError("PROCESSING_FAILED");
    }
    return produced;
  }

  /**
   * §21: coalesces download progress into at most one durable write per
   * PROGRESS_THROTTLE_MS. Once the store reports a terminal or conflicting
   * state, progress stops permanently and the active execution is aborted, so
   * a late event can never overwrite a terminal durable state.
   */
  private makeProgressReporter(jobId: string) {
    let lastProgressAt: number | null = null;
    let halted = false;

    return (p: {
      progress: number | null;
      downloadedBytes?: number | null;
      totalBytes?: number | null;
      speed?: number | null;
      eta?: number | null;
      stage?: string;
    }) => {
      if (halted) return;
      try {
        const now = this.getClock();
        const isFinal = p.progress === 100;
        if (!isFinal && lastProgressAt !== null && now - lastProgressAt < PROGRESS_THROTTLE_MS) {
          return;
        }
        lastProgressAt = now;

        const upRes = this.store.updateExecutionProgress(jobId, "downloading", {
          progress: p.progress != null && Number.isFinite(p.progress) ? p.progress : null,
          downloadedBytes: finiteInt(p.downloadedBytes),
          totalBytes: finiteInt(p.totalBytes),
          speed: finiteNonNegative(p.speed),
          eta: finiteNonNegative(p.eta),
          stageLabel: sanitizeForDurableState(p.stage || "Downloading", 255) || "Downloading",
        });

        if (upRes.type !== "updated") {
          halted = true;
          this.activeControllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED"));
        }
      } catch {
        halted = true;
        this.activeControllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED"));
      }
    };
  }

  private checkExpiry(job: DurableWorkerJob) {
    if (this.getClock() >= job.expiresAt) {
      throw new AppError("EXPIRED");
    }
  }

  private checkCancelled(signal: AbortSignal) {
    if (signal.aborted) {
      throw new AppError("PROCESSING_FAILED", "Job cancelled");
    }
  }

  private async cleanup(workDir: string) {
    try {
      await removeJobDir(workDir);
    } catch {
      /* cleanup is best effort and must never mask the terminal state */
    }
  }
}

function finiteInt(value: number | null | undefined): number | null {
  return value != null && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}
