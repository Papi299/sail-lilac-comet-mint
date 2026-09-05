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
  deriveExecutionPlan,
  executionPlanRequestedFormatId,
  executionPlanTargetContainer,
  type ExecutionPlan,
} from "./format-plan.ts";
import {
  downloadGenericOriginal,
  type GenericDownloadLimits,
} from "./ytdlp-download.server.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import type { GenericExecutionPlan } from "./format-plan.ts";
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

/**
 * §17/§35: the STRATEGY-AWARE execution analysis.
 *
 * A durable job re-analyzes its own stored URL at execution time and decides
 * direct-vs-generic itself. It never trusts the browser's earlier analysis and
 * never reads strategy back from durable state.
 */
export type AnalyzeForExecutionFn = (
  url: string,
  signal?: AbortSignal,
) => Promise<ExecutionAnalysis>;

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
 * §20: acquires the ONE original described by a generic execution plan. Like
 * the direct downloader it must never convert — but unlike the direct one it
 * DOES receive a plan, because the plan names the single upstream source the
 * Worker approved. It receives no browser value of any kind.
 */
export type DownloadGenericOriginalFn = (
  url: string,
  workDir: string,
  plan: GenericExecutionPlan,
  ctx: {
    limits: GenericDownloadLimits;
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
  /**
   * The authoritative, strategy-aware analysis. Production composition supplies
   * this, built from the SAME routing policy `WorkerService.analyze()` uses, so
   * the HTTP endpoint and durable jobs cannot drift apart (§43).
   */
  analyzeForExecution?: AnalyzeForExecutionFn;
  /**
   * A DIRECT-ONLY convenience seam. Supplying it states "direct analysis
   * returns this", and the executor adapts the result into a direct
   * `ExecutionAnalysis`. It cannot express a generic outcome, and production
   * never uses it.
   */
  analyze?: AnalyzeDirectMediaFn;
  downloadOriginal?: DownloadOriginalFn;
  downloadGeneric?: DownloadGenericOriginalFn;
  processLocally?: LocalProcessingFn;
  /** Bounds handed to generic acquisition. Defaults to the process config. */
  genericLimits?: GenericDownloadLimits;
};

/** Wraps a direct-only analyzer as a direct `ExecutionAnalysis`. */
function asDirectExecutionAnalysis(fn: AnalyzeDirectMediaFn): AnalyzeForExecutionFn {
  return async (url, signal) => ({
    strategy: "direct",
    video: await fn(url, signal),
    selections: {},
  });
}

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

/**
 * §22/§23 + PHASE-10D-WORKER-RESTART-RECOVERY-DETERMINISM-001: the provenance
 * of an operator-shutdown abort.
 *
 * Membership is decided by OBJECT IDENTITY of the very `AbortSignal` this
 * process aborted for a shutdown. It is deliberately NOT derived from:
 *
 *   - the human-readable message of any error;
 *   - the `PROCESSING_FAILED` code, which ordinary failures also carry;
 *   - `signal.aborted` alone, which a user cancellation and a halted progress
 *     reporter also set;
 *   - anything thrown by yt-dlp, the direct downloader or FFmpeg.
 *
 * The set is module-private and holds no strong reference, so nothing outside
 * this module — and no upstream payload — can add to it, read it, or forge it.
 * It is per-signal (therefore per-execution) rather than one global flag, so a
 * job that was never actually active and aborted can never be misclassified.
 */
const SHUTDOWN_ABORTED_SIGNALS = new WeakSet<AbortSignal>();

export class JobExecutor {
  private readonly store: WorkerJobStore;
  private readonly writer: ObjectStoreWriter;
  private readonly getClock: () => number;
  private readonly activeControllers: Map<string, AbortController>;
  private readonly analyzeForExecution: AnalyzeForExecutionFn;
  private readonly downloadOriginal: DownloadOriginalFn;
  private readonly downloadGeneric: DownloadGenericOriginalFn;
  private readonly processLocally: LocalProcessingFn;
  private readonly genericLimits: GenericDownloadLimits;

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
    // Fail-closed default: with no strategy-aware analyzer injected, execution
    // is DIRECT-ONLY. A deployment that forgets to compose the router therefore
    // behaves exactly as it did before Phase 10C3 rather than silently gaining
    // a generic path.
    this.analyzeForExecution =
      deps.analyzeForExecution ??
      asDirectExecutionAnalysis(deps.analyze ?? analyzeDirectMedia);
    this.downloadOriginal = deps.downloadOriginal ?? downloadDirectOriginalWorker;
    this.downloadGeneric =
      deps.downloadGeneric ??
      ((url, workDir, plan, ctx) =>
        downloadGenericOriginal(url, workDir, plan, {
          limits: ctx.limits,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
        }).then((res) => ({
          filePath: res.filePath,
          container: res.container,
          mime: mimeForContainer(res.container),
          fileSize: res.fileSize,
        })));
    this.processLocally = deps.processLocally ?? convertMedia;
    this.genericLimits = deps.genericLimits ?? {
      maxFileSizeBytes: config.maxFileSize,
      downloadTimeoutSeconds: Math.max(1, Math.floor(config.downloadTimeoutMs / 1000)),
    };
  }

  /** Number of executions currently holding an AbortController (§11 diagnostics). */
  public get activeJobCount(): number {
    return this.activeControllers.size;
  }

  /**
   * §22/§23: aborts every in-flight execution for an operator shutdown.
   *
   * INVARIANT (PHASE-10D-WORKER-RESTART-RECOVERY-DETERMINISM-001):
   * operator shutdown aborts execution for PROCESS HYGIENE ONLY. It
   * deliberately does not commit an ordinary terminal failure, and it
   * deliberately does not call `store.cancelJob()` — a restart is neither an
   * execution failure nor a user cancellation. An execution interrupted here
   * unwinds, cleans up its work directory, and leaves its durable row in the
   * ACTIVE state it had reached. That interrupted row is owned by the NEXT
   * process: `store.recover()` runs before anything can listen or execute and
   * classifies it deterministically as
   * `failed` / `PROCESSING_FAILED` / "Worker restarted before the job
   * completed." / stage `Worker restarted`.
   *
   * Letting the dying process classify the abort itself is what made the
   * durable outcome nondeterministic: whichever of the two writers happened to
   * win produced a different safe message for the same operator restart.
   *
   * Aborting is also what prevents descendant leakage: the hardened process
   * runner spawns media children detached into their own POSIX process group
   * and SIGKILLs the whole group on abort, so no FFmpeg descendant can outlive
   * the shutting-down Worker. That behaviour is unchanged.
   *
   * @returns the number of executions signalled.
   */
  public abortActiveForShutdown(): number {
    const controllers = [...this.activeControllers.values()];
    for (const controller of controllers) {
      // Provenance is recorded BEFORE the abort, so an abort listener that
      // runs synchronously already sees a marked signal.
      SHUTDOWN_ABORTED_SIGNALS.add(controller.signal);
      controller.abort(new AppError("PROCESSING_FAILED", "Worker shutting down"));
    }
    return controllers.length;
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
        // 1. Cancellation is checked FIRST and wins outright: if cancel won the
        //    durable CAS — even in the window between a shutdown abort and this
        //    catch — the terminal state it wrote must be preserved verbatim.
        const view = this.store.getJob(jobId);
        if (view && view.status === "cancelled") {
          return;
        }

        // 2. Operator shutdown is not an execution failure. THIS execution's
        //    own signal was marked before it was aborted, so the decision does
        //    not depend on the error object that yt-dlp, the direct downloader
        //    or FFmpeg happened to reject with. Return without failJob(): the
        //    durable row stays in its interrupted ACTIVE state and the next
        //    process's `store.recover()` owns the restart transition.
        if (SHUTDOWN_ABORTED_SIGNALS.has(signal)) {
          return;
        }
      }

      const code = this.classifyErrorCode(err);
      const safeMsg = ERROR_MESSAGES[code];
      // §27: the raw error is deliberately never logged and never persisted.
      this.store.failJob(jobId, code, safeMsg);
    } finally {
      // Cleanup is NEVER skipped, on any of the three outcomes above: the
      // active controller is unregistered and the per-job working directory is
      // removed even when the durable row is intentionally left active.
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
    // §17/§42: the job re-analyzes its OWN stored URL and re-decides the
    // strategy here. The browser's earlier analysis is not consulted, and the
    // durable `extractor` column is not read back as an input — a queued job's
    // value is null, and a previous attempt's value is history, not authority.
    const analysis = await this.analyzeForExecution(job.url, signal);
    const meta = analysis.video;

    // §8/§18: locate the exact selected item and derive the explicit execution
    // plan from trusted, runtime-validated metadata before any state advances.
    // On the generic path this also pins the single upstream source, so nothing
    // is left to be chosen later.
    const plan = deriveExecutionPlan(analysis, job.formatId);

    // §8: the strategy persisted here is EVIDENCE of what this execution
    // selected. It is never a browser field, never an input, and never a raw
    // upstream extractor name — `plan.strategy` is the closed
    // `direct` | `yt-dlp` union. No source selector and no upstream format id
    // is persisted: the selection is re-derived on any future attempt (§62).
    const analysisRes = this.store.completeAnalysis(jobId, {
      title: sanitizeForDurableState(meta.title, 1024) || "Video",
      thumbnail: meta.thumbnail || null,
      source: sanitizeForDurableState(meta.source, 2048) || "unknown",
      extractor: plan.strategy,
    });
    if (analysisRes.type !== "updated") return;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // ── downloading: ORIGINAL BYTES ONLY ─────────────────────────────────────
    // §4/§36: no FFmpeg work of any kind may start while the durable job says
    // `downloading`. Neither branch can convert: the direct downloader takes no
    // format at all, and the generic one acquires exactly the one progressive
    // source its plan names, with yt-dlp's own FFmpeg made unavailable.
    const original =
      plan.strategy === "direct"
        ? await this.downloadOriginal(job.url, {
            workDir,
            signal,
            onProgress: this.makeProgressReporter(jobId),
          })
        : await this.downloadGeneric(job.url, workDir, plan.generic, {
            limits: this.genericLimits,
            signal,
            onProgress: this.makeProgressReporter(jobId),
          });

    // ── processing ───────────────────────────────────────────────────────────
    const procRes = this.store.beginProcessing(jobId);
    if (procRes.type !== "updated") return;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // §11/§36: local processing happens strictly AFTER beginProcessing()
    // committed. This is the ONLY place Worker FFmpeg can be reached, on either
    // strategy.
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
    const container = executionPlanTargetContainer(plan);
    const requestedFormatId = executionPlanRequestedFormatId(plan);
    const quality = requestedFormatId.startsWith("preset:")
      ? requestedFormatId.slice("preset:".length)
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
    plan: ExecutionPlan,
    original: OriginalDownloadResult,
    workDir: string,
    signal: AbortSignal,
  ): Promise<string> {
    const operation =
      plan.strategy === "direct" ? plan.direct.operation : plan.generic.operation;
    const targetContainer = executionPlanTargetContainer(plan);

    if (operation === "keep-original") {
      if (original.container !== targetContainer) {
        throw new AppError("FORMAT_UNAVAILABLE");
      }
      return original.filePath;
    }

    // Every processing operation across both strategies targets exactly one of
    // these four. Checked rather than cast: `targetContainer` is widened by the
    // union of two plan types, and a silent cast here would be the one place a
    // container outside `convertMedia`'s closed vocabulary could reach FFmpeg.
    if (
      targetContainer !== "mp4" &&
      targetContainer !== "webm" &&
      targetContainer !== "mp3" &&
      targetContainer !== "m4a"
    ) {
      throw new AppError("PROCESSING_FAILED");
    }
    const target = targetContainer;
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
