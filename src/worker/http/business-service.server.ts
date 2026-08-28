import { isYtdlpNetworkIsolated } from "../../lib/config.ts";
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
import { analyzeDirectMedia } from "../execution/direct-media.server.ts";
import type { JobExecutor } from "../execution/job-executor.server.ts";
import { WORKER_MAX_CONCURRENT_JOBS, type QueuePump } from "../execution/queue-pump.server.ts";
import type { WorkerJobStore } from "../state/job-store.ts";
import { probeWorkerBinaries, type WorkerBinaryProbe } from "./binaries.server.ts";
import { WorkerBusinessError } from "./errors.server.ts";

/** Bound on the queue-depth scan reported by diagnostics. */
const QUEUE_DEPTH_SCAN_LIMIT = 1000;

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
};

export class WorkerService implements WorkerBusinessService {
  private readonly store: WorkerJobStore;
  private readonly executor: JobExecutor;
  private readonly pump: QueuePump;
  private readonly analyzeFn: AnalyzeFn;
  private readonly probeBinaries: WorkerBinaryProbe;
  private readonly clock: () => number;

  constructor(deps: WorkerServiceDeps) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.pump = deps.pump;
    // Direct-media only. There is no extractor registry, no yt-dlp, and no
    // sample extractor on this path (§24).
    this.analyzeFn = deps.analyze ?? analyzeDirectMedia;
    this.probeBinaries = deps.probeBinaries ?? probeWorkerBinaries;
    this.clock = deps.clock ?? (() => Date.now());
  }

  public async analyze(request: WorkerAnalyzeRequest): Promise<WorkerAnalyzeSuccess> {
    // analyzeDirectMedia performs the Worker's own independent URL/SSRF
    // validation and fails closed with EXTRACTOR_UNAVAILABLE for anything that
    // is not a direct media URL.
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
      binaries: { ffmpeg: binaries.ffmpeg, ytdlp: binaries.ytdlp },
      safeEgress: {
        // Read-only view of the operator attestation. Nothing here sets it, and
        // the absence of the environment variable stays fail-closed (false).
        attested: isYtdlpNetworkIsolated(),
        // Phase 9 owns safe-egress policy attestation; no policy state exists
        // yet, so this is reported honestly as absent rather than fabricated.
        policyVersion: null,
      },
    });
  }
}
