import {
  WorkerAnalyzeSuccessSchema,
  WorkerCancelJobSuccessSchema,
  WorkerCreateJobSuccessSchema,
  WorkerDiagnosticsSuccessSchema,
  WorkerJobStatusSuccessSchema,
  type WorkerAnalyzeRequest,
  type WorkerAnalyzeSuccess,
  type WorkerCancelJobSuccess,
  type WorkerCreateJobRequest,
  type WorkerCreateJobSuccess,
  type WorkerDiagnosticsSuccess,
  type WorkerJobStatusSuccess,
  type WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import {
  analyzeMedia,
  type GenericAnalysisLimits,
} from "../analysis/media-analyzer.server.ts";
import type { JobExecutor } from "../execution/job-executor.server.ts";
import { WORKER_MAX_CONCURRENT_JOBS, type QueuePump } from "../execution/queue-pump.server.ts";
import type { WorkerJobStore } from "../state/job-store.ts";
import { probeWorkerBinaries, type WorkerBinaryProbe } from "./binaries.server.ts";
import { WorkerBusinessError } from "./errors.server.ts";

/** Bound on the queue-depth scan reported by diagnostics. */
const QUEUE_DEPTH_SCAN_LIMIT = 1000;

/**
 * Bounds used only when composition supplied none.
 *
 * Deliberately conservative rather than permissive: an un-composed service that
 * somehow reached the generic path would analyze under tighter limits, never
 * looser ones. Production always injects the validated configuration.
 */
const CONSERVATIVE_ANALYSIS_LIMITS: GenericAnalysisLimits = {
  analysisTimeoutSeconds: 45,
  maxVideoDurationSeconds: 2 * 60 * 60,
  maxFileSizeBytes: 500 * 1024 * 1024,
};

/**
 * The narrow business boundary the authenticated HTTP surface dispatches into.
 *
 * The HTTP module owns method/path matching, body bounds, header parsing,
 * signature verification and replay reservation; it knows nothing about
 * SQLite, media, or storage. This interface is the only thing crossing over.
 */
export interface WorkerBusinessService {
  analyze(request: WorkerAnalyzeRequest): Promise<WorkerAnalyzeSuccess>;
  createJob(
    request: WorkerCreateJobRequest,
    idempotencyKey: string,
  ): Promise<{ status: 200 | 201; body: WorkerCreateJobSuccess }>;
  getJob(jobId: string): Promise<WorkerJobStatusSuccess>;
  cancelJob(jobId: string): Promise<WorkerCancelJobSuccess>;
  diagnostics(): Promise<WorkerDiagnosticsSuccess>;
}

export type AnalyzeFn = (url: string, signal?: AbortSignal) => Promise<WorkerVideoMetadata>;

export type WorkerServiceDeps = {
  store: WorkerJobStore;
  executor: JobExecutor;
  pump: QueuePump;
  analyze?: AnalyzeFn;
  probeBinaries?: WorkerBinaryProbe;
  clock?: () => number;
  /**
   * The validated `YTDLP_ENABLED` application feature state, supplied by the
   * composition root. This service never reads `process.env` itself — the
   * runtime configuration boundary owns that — and it defaults to disabled so
   * a caller that forgets to pass it cannot report a capability the deployment
   * did not grant.
   */
  ytdlpEnabled?: boolean;
  /**
   * Bounds for the generic analyzer, supplied by the composition root from
   * validated configuration. Only consulted when the generic path is both
   * enabled and actually reached.
   */
  analysisLimits?: GenericAnalysisLimits;
};

export class WorkerService implements WorkerBusinessService {
  private readonly store: WorkerJobStore;
  private readonly executor: JobExecutor;
  private readonly pump: QueuePump;
  private readonly analyzeFn: AnalyzeFn;
  private readonly probeBinaries: WorkerBinaryProbe;
  private readonly clock: () => number;
  private readonly ytdlpEnabled: boolean;
  private readonly analysisLimits: GenericAnalysisLimits;

  constructor(deps: WorkerServiceDeps) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.pump = deps.pump;
    // Fail-closed default: absent means disabled, exactly as YTDLP_ENABLED
    // itself behaves at the configuration boundary. Read BEFORE the analyzer is
    // built, because the analyzer closes over it.
    this.ytdlpEnabled = deps.ytdlpEnabled ?? false;
    this.analysisLimits = deps.analysisLimits ?? CONSERVATIVE_ANALYSIS_LIMITS;
    // Phase 10C3: analysis is the SHARED strategy router, not the direct
    // analyzer alone. It still tries direct FIRST and only considers generic on
    // exactly one error code, and only when the operator enabled it — so a
    // deployment with YTDLP_ENABLED unset behaves precisely as it did before.
    //
    // There is still no extractor registry and no legacy yt-dlp module on this
    // path: `analyzeMedia` reaches only the reviewed Phase-10 analyzers.
    this.analyzeFn =
      deps.analyze ??
      ((url, signal) =>
        analyzeMedia(url, {
          ytdlpEnabled: this.ytdlpEnabled,
          limits: this.analysisLimits,
          // Composition injects a policy with a real probe. The bare default
          // stays false, which can only REMOVE generic audio presets, never add
          // one that cannot be produced.
          ffmpegAvailable: false,
          ...(signal ? { signal } : {}),
        }));
    this.probeBinaries = deps.probeBinaries ?? probeWorkerBinaries;
    this.clock = deps.clock ?? (() => Date.now());
  }

  public async analyze(request: WorkerAnalyzeRequest): Promise<WorkerAnalyzeSuccess> {
    // The router performs the Worker's own independent URL/SSRF validation on
    // the direct attempt, and fails closed with EXTRACTOR_UNAVAILABLE for
    // anything that is not direct media when generic is disabled.
    const video = await this.analyzeFn(request.url);
    return WorkerAnalyzeSuccessSchema.parse({ success: true, video });
  }

  public async createJob(
    request: WorkerCreateJobRequest,
    idempotencyKey: string,
  ): Promise<{ status: 200 | 201; body: WorkerCreateJobSuccess }> {
    const result = this.store.createJob(request, idempotencyKey);

    switch (result.type) {
      case "created": {
        const body = WorkerCreateJobSuccessSchema.parse({ success: true, job: result.job });
        // Fire-and-forget: the HTTP response must not wait for media work.
        this.pump.wake();
        return { status: 201, body };
      }
      case "existing":
        return {
          status: 200,
          body: WorkerCreateJobSuccessSchema.parse({ success: true, job: result.job }),
        };
      case "conflict":
        // Same retained key, different payload. 409 is mandated; the code stays
        // inside the shared allowlist and carries only its canonical message.
        throw new WorkerBusinessError("PROCESSING_FAILED", 409);
      case "expired":
        throw new WorkerBusinessError("EXPIRED");
    }
  }

  public async getJob(jobId: string): Promise<WorkerJobStatusSuccess> {
    const job = this.store.getJob(jobId);
    if (!job) {
      throw new WorkerBusinessError("NOT_FOUND");
    }
    if (this.clock() >= job.expiresAt) {
      throw new WorkerBusinessError("EXPIRED");
    }
    return WorkerJobStatusSuccessSchema.parse({ success: true, job });
  }

  public async cancelJob(jobId: string): Promise<WorkerCancelJobSuccess> {
    // Routed through the executor, not the store, so an in-flight execution
    // receives the AbortSignal instead of merely losing its durable row.
    const result = this.executor.cancel(jobId);
    if (result.type === "not_found") {
      throw new WorkerBusinessError("NOT_FOUND");
    }
    // "cancelled" (this call won) and "unchanged" (a terminal state already
    // won) are both HTTP 200 with the authoritative committed job.
    return WorkerCancelJobSuccessSchema.parse({ success: true, job: result.job });
  }

  public async diagnostics(): Promise<WorkerDiagnosticsSuccess> {
    const binaries = await this.probeBinaries();
    const queueDepth = this.store.listQueuedJobs(QUEUE_DEPTH_SCAN_LIMIT).length;
    const runningJobs = this.executor.activeJobCount;

    return WorkerDiagnosticsSuccessSchema.parse({
      status: binaries.ffmpeg ? "ok" : "degraded",
      queueDepth,
      runningJobs,
      maxConcurrent: WORKER_MAX_CONCURRENT_JOBS,
      // "The pinned runtime executes", nothing more.
      binaries: { ffmpeg: binaries.ffmpeg, ytdlp: binaries.ytdlp },
      runtime: { ytdlpVersion: binaries.ytdlpVersion },
      // "The operator enabled the feature", which is independent of the above.
      // Both being true still does not mean a user URL can reach yt-dlp: no
      // such path exists in this phase.
      features: { ytdlpEnabled: this.ytdlpEnabled },
      safeEgress: {
        // Enforcement is external and this container cannot inspect it, so the
        // honest report is WHO enforces — not a boolean asserting that it
        // holds. The retired `attested` flag was an operator-set environment
        // variable that could only ever restate its own configuration.
        enforcement: "external",
        // Nothing that owns the policy publishes a version to the Worker, so
        // this stays null rather than fabricated.
        policyVersion: null,
      },
    });
  }
}
