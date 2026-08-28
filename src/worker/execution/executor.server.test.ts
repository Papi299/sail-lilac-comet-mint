import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { JobExecutor } from "./job-executor.server.ts";
import { QueueRunner } from "./queue-runner.server.ts";
import type { ObjectStoreWriter } from "@/worker/storage/writer.ts";
import { setSafeHttpTestHooks } from "@/lib/security/safe-http.server.ts";
import { Readable } from "node:stream";

describe("Job Executor and Queue Runner", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let executor: JobExecutor;
  let runner: QueueRunner;
  let tempDir: string;
  let fakeWriter: ObjectStoreWriter;
  
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-test-"));
    db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
    

    let lastPut: any = null;
    fakeWriter = {
      async head(key) { return { objectKey: key, contentLength: 8, contentType: "video/mp4", contentDisposition: lastPut?.contentDisposition || "attachment" } as any; },
      async put(opts) {
        lastPut = opts;
        for await (const chunk of opts.body) {}
      },
      async delete() {}
    };

    setSafeHttpTestHooks({
      lookup: async (hostname) => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: async (args) => {
        if (args.method === "HEAD") {
          return { status: 200, headers: { "content-length": "8", "content-type": "video/mp4" }, body: null };
        }
        return {
          status: 200,
          headers: { "content-length": "8", "content-type": "video/mp4" },
          body: Readable.from([Buffer.from("mockdata")])
        };
      }
    });

    executor = new JobExecutor(store, fakeWriter, () => Date.now());
    runner = new QueueRunner(store, executor);
  });

  afterEach(async () => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    setSafeHttpTestHooks(null);
  });

  it("queue runner executes job end-to-end", async () => {
    const url = "http://example.com/test.mp4";
    
    store.createJob({ url, formatId: "direct-original", principalId: "private-access-user" }, randomUUID());
    
    const res = await runner.runNext();
    assert.strictEqual(res.type, "executed");
    
    const job = store.getJob(res.type === "executed" ? res.jobId : "");
    if (job?.status !== "ready") console.error(job?.safeErrorMessage, job?.errorCode);
    assert.strictEqual(job?.status, "ready");
    assert.ok(job?.objectKey);
  });
});
