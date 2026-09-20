import { createReadStream } from "node:fs";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import { buildDownloadFilename } from "@/lib/filenames";
import { config } from "@/lib/config";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { createJobDir, removeJobDir } from "@/services/temp/files.server";
import { analyzeDirectMedia } from "./direct-media.server.ts";
import { downloadDirectOriginalWorker } from "@/services/extractors/direct.server";
import { mimeForContainer } from "@/services/extractors/normalize";
import {
  SPLIT_MERGE_TARGETS,
  convertMedia,
  mergeSplitMedia,
  type SplitMergeTarget,
} from "@/services/processing/ffmpeg.server";
import { validateLocalOutput } from "./local-output.server.ts";
import { requiredWorkspaceBytes, workspaceFootprintForPlan } from "./workspace-capacity.ts";
import {
  deriveExecutionPlan,
  executionPlanRequestedFormatId,
  executionPlanTargetContainer,
  type DirectExecutionPlan,
  type ExecutionPlan,
  type GenericSingleSourceExecutionPlan,
  type GenericSplitExecutionPlan,
} from "./format-plan.ts";
import {
  downloadGenericOriginal,
  downloadGenericSplitSources,
  type GenericDownloadLimits,
  type GenericSplitSourcesDownload,
} from "./ytdlp-download.server.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
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

/** What either generic acquisition seam receives besides the URL, workDir and plan. */
export type GenericAcquisitionContext = {
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
};

/**
 * §20: acquires the ONE original described by a generic execution plan. Like
 * the direct downloader it must never convert — but unlike the direct one it
 * DOES receive a plan, because the plan names the single upstream source the
 * Worker approved. It receives no browser value of any kind.
 *
 * SPLIT-04: typed on the SINGLE-SOURCE plan variants only. A `merge-split` plan
 * names two sources and has its own seam below, so handing one to this seam is
 * a compile error rather than a runtime refusal someone could later remove.
 */
export type DownloadGenericOriginalFn = (
  url: string,
  workDir: string,
  plan: GenericSingleSourceExecutionPlan,
  ctx: GenericAcquisitionContext,
) => Promise<OriginalDownloadResult>;

/**
 * SPLIT-04: acquires BOTH halves of one approved split pair — the exact
 * complement of `DownloadGenericOriginalFn`. It takes only a `merge-split`
 * plan, so neither seam can be asked to do the other's job. Like every
 * acquisition seam it performs no local media work: the merge is a separate
 * seam, reachable only after `beginProcessing()` commits.
 */
export type DownloadGenericSplitFn = (
  url: string,
  workDir: string,
  plan: GenericSplitExecutionPlan,
  ctx: GenericAcquisitionContext,
) => Promise<GenericSplitSourcesDownload>;

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

/**
 * SPLIT-04: the TWO-input local merge, dependency-injected for the same reason
 * as `LocalProcessingFn`. Deliberately a separate seam: a merge has no single
 * "input", and fabricating one to reuse the one-input seam would hide which
 * half is which.
 */
export type MergeSplitMediaFn = (opts: {
  videoPath: string;
  audioPath: string;
  workDir: string;
  target: SplitMergeTarget;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}) => Promise<string>;

/** SPLIT-04: bytes available on the filesystem holding a job's workDir. */
export type AvailableWorkDirBytesFn = (workDir: string) => Promise<number>;

/**
 * SPLIT-04: the plans whose acquisition yields exactly ONE local original —
 * every direct plan, and every generic plan except `merge-split`.
 */
type SingleSourceExecutionPlan =
  | { readonly strategy: "direct"; readonly direct: DirectExecutionPlan }
  | { readonly strategy: "yt-dlp"; readonly generic: GenericSingleSourceExecutionPlan };

/**
 * SPLIT-04: what the downloading phase hands to the processing phase.
 *
 * Each variant carries the plan it was acquired FOR, so processing dispatches
 * on one discriminant and receives a plan and a result that belong together.
 * "single plan + split result" and "split plan + single result" are not
 * pairings any code path can form. A split acquisition is never flattened
 * into a fake `OriginalDownloadResult`: a two-input merge has no one original.
 */
type AcquiredExecutionMedia =
  | {
      readonly kind: "single";
      readonly plan: SingleSourceExecutionPlan;
      readonly original: OriginalDownloadResult;
    }
  | {
      readonly kind: "split";
      readonly plan: GenericSplitExecutionPlan;
      readonly sources: GenericSplitSourcesDownload;
    };

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
  /** SPLIT-04: dual-source acquisition. Production: SPLIT-03's primitive. */
  downloadGenericSplit?: DownloadGenericSplitFn;
  processLocally?: LocalProcessingFn;
  /** SPLIT-04: the two-input merge. Production: SPLIT-02's `mergeSplitMedia`. */
  mergeSplit?: MergeSplitMediaFn;
  /**
   * The plan-aware media-workspace preflight's reader (SPLIT-04, generalized by
   * MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001). Production: `statfs` on the workDir.
   */
  availableWorkDirBytes?: AvailableWorkDirBytesFn;
  /** Bounds handed to generic acquisition. Defaults to the process config. */
  genericLimits?: GenericDownloadLimits;
};

/**
 * Wraps a direct-only analyzer as a direct `ExecutionAnalysis`.
 *
 * Both private maps are empty literals. The executor names no HLS module at
 * all — it does not import the HLS-5 selection type, does not read
 * `hlsSelections`, and has no HLS branch — so the dormant channel stays
 * entirely upstream of it (HLS-6 is what changes that).
 */
function asDirectExecutionAnalysis(fn: AnalyzeDirectMediaFn): AnalyzeForExecutionFn {
  return async (url, signal) => ({
    strategy: "direct",
    video: await fn(url, signal),
    selections: {},
    hlsSelections: {},
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
  private readonly downloadGenericSplit: DownloadGenericSplitFn;
  private readonly processLocally: LocalProcessingFn;
  private readonly mergeSplit: MergeSplitMediaFn;
  private readonly availableWorkDirBytes: AvailableWorkDirBytesFn;
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
    this.downloadGenericSplit =
      deps.downloadGenericSplit ??
      ((url, workDir, plan, ctx) =>
        downloadGenericSplitSources(url, workDir, plan, {
          limits: ctx.limits,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
        }));
    this.processLocally = deps.processLocally ?? convertMedia;
    this.mergeSplit = deps.mergeSplit ?? mergeSplitMedia;
    this.availableWorkDirBytes = deps.availableWorkDirBytes ?? availableBytesOnWorkDirFilesystem;
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
    // `downloading`. No acquisition branch can convert: the direct downloader
    // takes no format at all, the generic one acquires exactly the one
    // progressive source its plan names, and the split one acquires exactly the
    // two its pair names — in both generic cases with yt-dlp's own FFmpeg made
    // unavailable. None of them probes, merges or otherwise touches media.
    const acquired = await this.acquire(job.url, plan, workDir, signal, jobId);

    // ── processing ───────────────────────────────────────────────────────────
    const procRes = this.store.beginProcessing(jobId);
    if (procRes.type !== "updated") return;

    this.checkExpiry(job);
    this.checkCancelled(signal);

    // §11/§36: local processing happens strictly AFTER beginProcessing()
    // committed. This is the ONLY place Worker FFmpeg — or, for a split pair,
    // ffprobe and the merge — can be reached, on any strategy.
    const producedPath =
      acquired.kind === "split"
        ? await this.executeSplitPlan(acquired.plan, acquired.sources, workDir, signal)
        : await this.executePlan(acquired.plan, acquired.original, workDir, signal);

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
   * The downloading phase: routes the plan to exactly ONE acquisition seam and
   * returns its result bound to the plan it was acquired for.
   *
   *   direct                      -> `downloadOriginal`
   *   generic keep/extract-*      -> `downloadGeneric`       (one source)
   *   generic `merge-split`       -> `downloadGenericSplit`  (two sources)
   *
   * The two generic seams are typed on complementary plan variants, so a pair
   * cannot reach the single-source seam and a single source cannot reach the
   * split one. Every seam runs while the durable status is `downloading`, and
   * every result is checked here, at the module boundary, before processing
   * may see it.
   */
  private async acquire(
    url: string,
    plan: ExecutionPlan,
    workDir: string,
    signal: AbortSignal,
    jobId: string,
  ): Promise<AcquiredExecutionMedia> {
    // MAX-FILE-SIZE-4GIB: EVERY plan is preflighted against the workspace it is
    // about to fill — after the trusted plan was derived, before any
    // acquisition seam is reached, and on the canonical per-job workDir.
    await this.assertWorkDirCapacity(workDir, plan);
    this.checkCancelled(signal);

    if (plan.strategy === "direct") {
      const original = await this.downloadOriginal(url, {
        workDir,
        signal,
        onProgress: this.makeProgressReporter(jobId),
      });
      return { kind: "single", plan, original: assertSingleOriginal(original) };
    }

    const generic = plan.generic;
    if (generic.operation !== "merge-split") {
      const original = await this.downloadGeneric(url, workDir, generic, {
        limits: this.genericLimits,
        signal,
        onProgress: this.makeProgressReporter(jobId),
      });
      return {
        kind: "single",
        plan: { strategy: "yt-dlp", generic },
        original: assertSingleOriginal(original),
      };
    }

    // ── SPLIT-04: one approved pair ─────────────────────────────────────────
    //
    // WorkDir ownership, which the split security argument rests on: `workDir`
    // is the canonical per-job directory `createJobDir(jobId)` made for THIS
    // execution. It is never derived from a browser value, exactly one executor
    // runs this job, no other application writer ever targets it, and this
    // executor's `finally` alone removes it. Within it, SPLIT-03 requires an
    // exactly-empty directory before the video run and exactly `{video}` before
    // the audio run, and SPLIT-02 refuses any pre-existing merge output entry.
    // Neither primitive cleans up: partial artifacts stay until this executor
    // unwinds. The 2 × maxFileSizeBytes capacity this relies on was already
    // proven by the plan-aware preflight at the top of this method.

    // Acquisition progress is live only while acquisition is. SPLIT-03 already
    // gates its own monitor; this gate is the executor's, so a late callback
    // from ANY split implementation is inert once the call has settled — before
    // `beginProcessing()` is even attempted — instead of reaching the reporter,
    // losing the `downloading` CAS and aborting a job that had succeeded.
    const report = this.makeProgressReporter(jobId);
    let acquisitionLive = true;
    let sources: unknown;
    try {
      sources = await this.downloadGenericSplit(url, workDir, generic, {
        limits: this.genericLimits,
        signal,
        onProgress: (update) => {
          if (acquisitionLive) report(update);
        },
      });
    } finally {
      acquisitionLive = false;
    }
    return {
      kind: "split",
      plan: generic,
      sources: assertSplitSources(generic, sources, this.genericLimits.maxFileSizeBytes),
    };
  }

  /**
   * The plan-aware media-workspace PREFLIGHT (SPLIT-04 §13, generalized from
   * split-only by MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001).
   *
   * The requirement is derived SOLELY from the trusted execution plan, by
   * `workspace-capacity.ts`: 1 × maxFileSizeBytes for keep-original (direct or
   * generic), 2 × for every plan whose original and produced artifact coexist —
   * direct convert / extract-m4a / extract-mp3, generic extract-m4a /
   * extract-mp3, and generic merge-split. Those hard bounds of a successful job
   * ARE the proof, so no padding is added.
   *
   * A lower-bound check at one instant — not a reservation, and no claim that
   * free space cannot change afterwards. Local disk is Worker capacity, not a
   * property of the media, so every refusal is PROCESSING_FAILED, never
   * TOO_LARGE. A ceiling with no honest requirement (not a positive safe
   * integer, or one whose multiple overflows) is refused without reading the
   * filesystem. The measured value is never logged, persisted or put in an
   * error.
   */
  private async assertWorkDirCapacity(workDir: string, plan: ExecutionPlan): Promise<void> {
    let required: number | null;
    try {
      required = requiredWorkspaceBytes(
        this.genericLimits.maxFileSizeBytes,
        workspaceFootprintForPlan(plan),
      );
    } catch {
      throw new AppError("PROCESSING_FAILED");
    }
    if (required === null) throw new AppError("PROCESSING_FAILED");

    let available: number;
    try {
      available = await this.availableWorkDirBytes(workDir);
    } catch {
      throw new AppError("PROCESSING_FAILED");
    }
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new AppError("PROCESSING_FAILED");
    }
    if (available < required) throw new AppError("PROCESSING_FAILED");
  }

  /**
   * SPLIT-04: executes a `merge-split` plan — SPLIT-02's two-input stream-copy
   * merge of the two acquired halves. Reached only after `beginProcessing()`
   * committed, exactly like the one-input path.
   *
   * Every argument is bound here and nowhere else: the video half to
   * `videoPath`, the audio half to `audioPath`, the plan's table-derived target,
   * the same application-owned processing timeout the one-input path uses (not
   * what is left of the acquisition deadline), and ONE normal product ceiling
   * for the delivered artifact. No pair member is re-selected, no fallback
   * source exists, and nothing is inferred from codecs.
   */
  private async executeSplitPlan(
    plan: GenericSplitExecutionPlan,
    sources: GenericSplitSourcesDownload,
    workDir: string,
    signal: AbortSignal,
  ): Promise<string> {
    // Checked against SPLIT-02's own closed vocabulary rather than cast: the
    // target chooses both demuxers, the muxer and the output name there.
    const target: string = plan.targetContainer;
    if (!isSplitMergeTarget(target)) throw new AppError("PROCESSING_FAILED");

    const produced = await this.mergeSplit({
      videoPath: sources.video.filePath,
      audioPath: sources.audio.filePath,
      workDir,
      target,
      timeoutMs: config.downloadTimeoutMs,
      maxOutputBytes: this.genericLimits.maxFileSizeBytes,
      signal,
    });

    // The delivered artifact must be the merge's own output: the planned
    // extension, and never one of the two halves handed back as if merged.
    if (!produced.endsWith(`.${target}`)) throw new AppError("PROCESSING_FAILED");
    if (produced === sources.video.filePath || produced === sources.audio.filePath) {
      throw new AppError("PROCESSING_FAILED");
    }
    return produced;
  }

  /**
   * §9 + §10: executes exactly the derived plan. `plan.targetContainer` is a
   * closed union, so no user-supplied string ever becomes an FFmpeg target,
   * an output extension, or a path segment.
   *
   * SPLIT-04: single-source plans only. A `merge-split` plan is not a member
   * of `SingleSourceExecutionPlan`, so it can never be "processed" here as a
   * one-input conversion of one half.
   */
  private async executePlan(
    plan: SingleSourceExecutionPlan,
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

/**
 * SPLIT-04: the production capacity reader — the bytes an unprivileged process
 * may still allocate (`bavail`, not `bfree`) on the filesystem holding
 * `workDir`, via Node's `statfs`.
 *
 * Read as bigint so a very large filesystem cannot lose precision. A value
 * beyond MAX_SAFE_INTEGER is clamped DOWN to it; that can never turn an
 * insufficient filesystem into a sufficient one, because every requirement the
 * gate compares it with is itself a safe integer.
 */
export async function availableBytesOnWorkDirFilesystem(workDir: string): Promise<number> {
  const fs = await statfs(workDir, { bigint: true });
  const bytes = fs.bavail * fs.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

/** True when `value` is one of SPLIT-02's closed merge targets. */
function isSplitMergeTarget(value: string): value is SplitMergeTarget {
  return (SPLIT_MERGE_TARGETS as readonly string[]).includes(value);
}

/**
 * SPLIT-04: a single-source acquisition must hand back ONE local file path.
 *
 * Every real single-source downloader already does; this only makes a result
 * of another shape — a split pair's `{video, audio, totalFileSize}` included —
 * fail closed at the boundary instead of reaching processing as `undefined`.
 */
function assertSingleOriginal(raw: OriginalDownloadResult): OriginalDownloadResult {
  const filePath: unknown = (raw as { filePath?: unknown } | null)?.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  return raw;
}

const SplitSourceArtifactSchema = z
  .object({
    filePath: z.string().min(1),
    container: z.string().min(1),
    fileSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const SplitSourcesDownloadSchema = z
  .object({
    video: SplitSourceArtifactSchema,
    audio: SplitSourceArtifactSchema,
    totalFileSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * SPLIT-04: the executor's own proof that a split acquisition returned what a
 * pair acquisition must return.
 *
 * SPLIT-03's primitive already guarantees every property below. They are
 * re-proven because this is a module boundary: the executor does not trust an
 * injected or alternate implementation merely because the production one is
 * correct, and malformed data is refused, never interpreted charitably.
 *
 *   - a structurally broken result (a missing half, an empty path, a
 *     non-integer size, a total that is not the exact safe sum of the halves,
 *     one file named twice) is PROCESSING_FAILED — SPLIT-03's own convention
 *     for an acquired artifact that is not what it should be;
 *   - a half whose container is not the one the pair approved is
 *     FORMAT_UNAVAILABLE — the executor's existing convention at this exact
 *     boundary (see `executePlan`'s keep-original check): the acquired media is
 *     not the approved rendition, and substituting it is what §17 forbids;
 *   - a total over the one combined byte budget is TOO_LARGE, as SPLIT-03
 *     classifies the same condition.
 *
 * Nothing here is persisted, and no path appears in any error.
 */
function assertSplitSources(
  plan: GenericSplitExecutionPlan,
  raw: unknown,
  maxFileSizeBytes: number,
): GenericSplitSourcesDownload {
  const parsed = SplitSourcesDownloadSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("PROCESSING_FAILED");
  const { video, audio, totalFileSize } = parsed.data;

  if (video.container !== plan.pair.video.container) throw new AppError("FORMAT_UNAVAILABLE");
  if (audio.container !== plan.pair.audio.container) throw new AppError("FORMAT_UNAVAILABLE");

  if (video.filePath === audio.filePath) throw new AppError("PROCESSING_FAILED");

  const sum = video.fileSize + audio.fileSize;
  if (!Number.isSafeInteger(sum) || totalFileSize !== sum) {
    throw new AppError("PROCESSING_FAILED");
  }
  if (totalFileSize > maxFileSizeBytes) throw new AppError("TOO_LARGE");

  return parsed.data;
}
