import type { WorkerJobStore } from "@/worker/state/job-store";
import type { JobExecutor } from "./job-executor.server.ts";

export class QueueRunner {
  private readonly store: WorkerJobStore;
  private readonly executor: JobExecutor;

  constructor(
    store: WorkerJobStore,
    executor: JobExecutor
  ) {
    this.store = store;
    this.executor = executor;
  }

  public async runNext(): Promise<{ type: "idle" } | { type: "executed"; jobId: string }> {
    const job = this.store.claimNextQueuedJob();
    if (!job) {
      return { type: "idle" };
    }
    await this.executor.execute(job);
    return { type: "executed", jobId: job.jobId };
  }
}
