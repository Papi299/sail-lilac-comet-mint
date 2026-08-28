import test from "node:test";
import assert from "node:assert";
import { QueueRunner } from "./queue-runner.server.ts";
import type { DurableWorkerJob, WorkerJobStore } from "@/worker/state/job-store";
import type { JobExecutor } from "./job-executor.server.ts";

test("QueueRunner acceptance", async (t) => {
  const mockStore = () => {
    const queue: DurableWorkerJob[] = [];
    return {
      queue,
      claimNextQueuedJob: () => {
        const job = queue.shift();
        if (job) {
          if (job.status === "cancelled") return null;
          return job;
        }
        return null;
      },
    } as unknown as WorkerJobStore;
  };

  const mockExecutor = () => {
    const executed: string[] = [];
    return {
      executed,
      execute: async (job: DurableWorkerJob) => {
        if (job.url === "fail") return; // executor catches and doesn't throw
        executed.push(job.jobId);
      },
    } as unknown as JobExecutor;
  };

  await t.test("empty: idle", async () => {
    const store = mockStore();
    const executor = mockExecutor();
    const runner = new QueueRunner(store, executor);
    while ((await runner.runNext()).type !== 'idle') { /* loop */ }
    assert.deepStrictEqual((executor as any).executed, []);
  });

  await t.test("one queued: exactly one job", async () => {
    const store = mockStore();
    (store as any).queue.push({ jobId: "job-1", status: "queued" });
    const executor = mockExecutor();
    const runner = new QueueRunner(store, executor);
    while ((await runner.runNext()).type !== 'idle') { /* loop */ }
    assert.deepStrictEqual((executor as any).executed, ["job-1"]);
  });

  await t.test("two queued: FIFO", async () => {
    const store = mockStore();
    (store as any).queue.push({ jobId: "job-1", status: "queued" }, { jobId: "job-2", status: "queued" });
    const executor = mockExecutor();
    const runner = new QueueRunner(store, executor);
    while ((await runner.runNext()).type !== 'idle') { /* loop */ } // process first job and loop
    assert.deepStrictEqual((executor as any).executed, ["job-1", "job-2"]);
  });

  await t.test("cancelled: never claimed", async () => {
    const store = mockStore();
    (store as any).queue.push({ jobId: "job-1", status: "cancelled" });
    const executor = mockExecutor();
    const runner = new QueueRunner(store, executor);
    while ((await runner.runNext()).type !== 'idle') { /* loop */ }
    assert.deepStrictEqual((executor as any).executed, []);
  });

  await t.test("failed execution: next queued job remains intact", async () => {
    const store = mockStore();
    (store as any).queue.push({ jobId: "job-1", url: "fail", status: "queued" }, { jobId: "job-2", status: "queued" });
    const executor = mockExecutor();
    const runner = new QueueRunner(store, executor);
    while ((await runner.runNext()).type !== 'idle') { /* loop */ }
    assert.deepStrictEqual((executor as any).executed, ["job-2"]);
  });
});
