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

test("QueueRunner over a REAL SQLite store", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { applyMigrations } = await import("@/worker/state/migrations.server.ts");
  const { SQLiteJobStore } = await import("@/worker/state/sqlite-job-store.server.ts");

  const ID_A = "a".repeat(32);
  const ID_B = "b".repeat(32);
  const ID_C = "c".repeat(32);

  function makeStore(clockValues: number[], jobIds: string[]) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "queue-fifo-"));
    const db = new DatabaseSync(nodePath.join(dir, "test.sqlite"));
    applyMigrations(db);
    let clockIndex = 0;
    let idIndex = 0;
    const store = new SQLiteJobStore({
      db,
      clock: () => clockValues[Math.min(clockIndex, clockValues.length - 1)]!,
      generateJobId: () => jobIds[idIndex++]!,
    });
    return {
      db,
      store,
      advanceClock: () => {
        clockIndex += 1;
      },
      cleanup: () => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function recordingExecutor(executed: string[], failing: Set<string> = new Set()) {
    return {
      execute: async (job: DurableWorkerJob) => {
        if (failing.has(job.jobId)) return; // the executor never rethrows
        executed.push(job.jobId);
      },
    } as unknown as JobExecutor;
  }

  await t.test("claims two real queued jobs in createdAt order", async () => {
    // Job A is created at t=1000, job B at t=2000, but B sorts first by id.
    const h = makeStore([1000, 2000, 3000], [ID_B, ID_A]);
    try {
      h.store.createJob(
        { url: "https://cdn.example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "11111111-1111-4111-8111-111111111111",
      );
      h.advanceClock();
      h.store.createJob(
        { url: "https://cdn.example.com/b.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "22222222-2222-4222-8222-222222222222",
      );
      h.advanceClock();

      const executed: string[] = [];
      const runner = new QueueRunner(h.store, recordingExecutor(executed));
      while ((await runner.runNext()).type !== "idle") { /* drain */ }

      // Older createdAt wins even though its jobId sorts later.
      assert.deepStrictEqual(executed, [ID_B, ID_A]);
    } finally {
      h.cleanup();
    }
  });

  await t.test("breaks a createdAt tie deterministically by jobId", async () => {
    const h = makeStore([5000, 5000, 6000], [ID_C, ID_A, ID_B]);
    try {
      for (const key of [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ]) {
        h.store.createJob(
          { url: "https://cdn.example.com/x.mp4", formatId: "direct-original", principalId: "private-access-user" },
          key,
        );
      }
      h.advanceClock();
      h.advanceClock();

      const executed: string[] = [];
      const runner = new QueueRunner(h.store, recordingExecutor(executed));
      while ((await runner.runNext()).type !== "idle") { /* drain */ }

      assert.deepStrictEqual(executed, [ID_A, ID_B, ID_C], "identical createdAt orders by jobId ASC");
    } finally {
      h.cleanup();
    }
  });

  await t.test("an empty real queue is idle and claims nothing", async () => {
    const h = makeStore([1000], [ID_A]);
    try {
      const executed: string[] = [];
      const runner = new QueueRunner(h.store, recordingExecutor(executed));
      assert.strictEqual((await runner.runNext()).type, "idle");
      assert.deepStrictEqual(executed, []);
    } finally {
      h.cleanup();
    }
  });

  await t.test("a failing job does not block the next real queued job", async () => {
    const h = makeStore([1000, 2000, 3000], [ID_A, ID_B]);
    try {
      h.store.createJob(
        { url: "https://cdn.example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "66666666-6666-4666-8666-666666666666",
      );
      h.advanceClock();
      h.store.createJob(
        { url: "https://cdn.example.com/b.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "77777777-7777-4777-8777-777777777777",
      );
      h.advanceClock();

      const executed: string[] = [];
      const runner = new QueueRunner(h.store, recordingExecutor(executed, new Set([ID_A])));
      while ((await runner.runNext()).type !== "idle") { /* drain */ }

      assert.deepStrictEqual(executed, [ID_B], "the surviving job still runs");
    } finally {
      h.cleanup();
    }
  });

  await t.test("a claimed job is never claimed twice", async () => {
    const h = makeStore([1000, 2000], [ID_A]);
    try {
      h.store.createJob(
        { url: "https://cdn.example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "88888888-8888-4888-8888-888888888888",
      );
      h.advanceClock();

      const first = h.store.claimNextQueuedJob();
      assert.ok(first);
      assert.strictEqual(first.status, "analyzing");
      assert.strictEqual(h.store.claimNextQueuedJob(), null, "an in-flight job is not re-claimable");
    } finally {
      h.cleanup();
    }
  });

  await t.test("expired queued jobs are never claimed", async () => {
    const h = makeStore([1000, 1000], [ID_A]);
    try {
      h.store.createJob(
        { url: "https://cdn.example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "99999999-9999-4999-8999-999999999999",
      );
      const job = h.store.getJob(ID_A)!;

      // A second store over the SAME database, whose clock has moved past the
      // job's expiry, must refuse to claim or even list it.
      const stale = new SQLiteJobStore({ db: h.db, clock: () => job.expiresAt + 1 });
      assert.strictEqual(stale.claimNextQueuedJob(), null, "an expired job is not claimable");
      assert.deepStrictEqual(stale.listQueuedJobs(10), []);

      // The row itself is untouched: expiry is a read-time guard, not a mutation.
      assert.strictEqual(h.store.getJob(ID_A)!.status, "queued");
    } finally {
      h.cleanup();
    }
  });

  await t.test("importing the queue runner starts no background polling", async () => {
    const h = makeStore([1000, 2000], [ID_A]);
    try {
      h.store.createJob(
        { url: "https://cdn.example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      h.advanceClock();

      // Nothing may claim the job unless runNext() is called explicitly.
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.strictEqual(h.store.getJob(ID_A)!.status, "queued", "no import-time polling");

      const executed: string[] = [];
      const runner = new QueueRunner(h.store, recordingExecutor(executed));
      assert.strictEqual((await runner.runNext()).type, "executed");
      assert.deepStrictEqual(executed, [ID_A]);
    } finally {
      h.cleanup();
    }
  });
});
