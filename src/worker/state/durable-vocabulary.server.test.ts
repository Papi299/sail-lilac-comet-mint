import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";
import {
  CompleteAnalysisInputSchema,
  DurableWorkerJobSchema,
} from "./job-store.ts";
import { WORKER_REQUESTED_FORMAT_IDS } from "../../shared/worker/contracts.ts";

/**
 * CORRECTION-01 §15-§22: the DURABLE trust boundary.
 *
 * Phase 10C3 introduced closed application vocabularies but left the durable
 * schemas accepting arbitrary strings, so a SQLite row could still carry
 * `extractor = "Youtube"` or `formatId = "bestvideo+bestaudio"` and become
 * trusted execution state. A raw row is not trustworthy merely because some
 * earlier value passed an HTTP request schema — it may have been written by an
 * older build, edited out of band, or corrupted.
 *
 * These tests exercise the hydration and write boundaries DIRECTLY, so a
 * rejection is proven where it happens rather than being inferred from a later
 * failure inside `deriveExecutionPlan()`.
 */

const BASE_ROW = {
  jobId: "0123456789abcdef0123456789abcdef",
  url: "https://example.invalid/watch/abc",
  formatId: "preset:1080",
  principalId: "private-access-user",
  status: "queued",
  progress: null,
  stageLabel: null,
  downloadedBytes: null,
  totalBytes: null,
  speed: null,
  eta: null,
  errorCode: null,
  safeErrorMessage: null,
  filename: null,
  fileSize: null,
  mime: null,
  quality: null,
  container: null,
  title: null,
  thumbnail: null,
  source: null,
  extractor: null,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
  objectKey: null,
  startedAt: null,
  finishedAt: null,
} as const;

function row(overrides: Record<string, unknown> = {}) {
  return { ...BASE_ROW, ...overrides };
}

describe("durable hydration: closed strategy vocabulary (§17/§21)", () => {
  it("accepts exactly null, direct and yt-dlp", () => {
    for (const extractor of [null, "direct", "yt-dlp"]) {
      const parsed = DurableWorkerJobSchema.safeParse(row({ extractor }));
      assert.equal(parsed.success, true, `${String(extractor)} must hydrate`);
    }
  });

  // Upstream `extractor` / `extractor_key` values, a plausible corruption, and
  // casing variants. None may become trusted strategy state.
  const REJECTED_STRATEGIES = [
    "Youtube",
    "youtube",
    "generic",
    "evil",
    "Direct",
    "YT-DLP",
    "yt_dlp",
    "ytdlp",
    "direct ",
    " direct",
    "",
    "vimeo:album",
  ];

  for (const extractor of REJECTED_STRATEGIES) {
    it(`rejects extractor ${JSON.stringify(extractor)} at the hydration boundary`, () => {
      const parsed = DurableWorkerJobSchema.safeParse(row({ extractor }));
      assert.equal(
        parsed.success,
        false,
        "an arbitrary strategy string must not hydrate into execution state",
      );
    });
  }

  it("rejects a non-string, non-null extractor", () => {
    for (const extractor of [1, true, {}, []]) {
      assert.equal(DurableWorkerJobSchema.safeParse(row({ extractor })).success, false);
    }
  });
});

describe("durable hydration: closed format vocabulary (§16/§21)", () => {
  it("accepts every member of the application vocabulary and nothing else", () => {
    for (const formatId of WORKER_REQUESTED_FORMAT_IDS) {
      assert.equal(
        DurableWorkerJobSchema.safeParse(row({ formatId })).success,
        true,
        `${formatId} must hydrate`,
      );
    }
    assert.equal(WORKER_REQUESTED_FORMAT_IDS.length, 12);
  });

  // Raw upstream ids and selector expressions — exactly what the old
  // `z.string().min(1)` would have accepted straight into execution state.
  const REJECTED_FORMATS = [
    "22",
    "137",
    "bestvideo+bestaudio",
    "bv*+ba",
    "best",
    "worst",
    "all",
    "mergeall",
    "http-1080",
    "preset:does-not-exist",
    "preset:4320",
    "PRESET:1080",
    "preset:1080 ",
    "direct-original-x",
    "",
    "arbitrary string",
  ];

  for (const formatId of REJECTED_FORMATS) {
    it(`rejects formatId ${JSON.stringify(formatId)} at the hydration boundary`, () => {
      const parsed = DurableWorkerJobSchema.safeParse(row({ formatId }));
      assert.equal(
        parsed.success,
        false,
        "an out-of-vocabulary formatId must not hydrate into execution state",
      );
      // And it fails HERE, on the formatId field — not incidentally elsewhere.
      if (!parsed.success) {
        assert.ok(
          parsed.error.issues.some((i) => i.path.join(".") === "formatId"),
          "the rejection must be attributed to formatId",
        );
      }
    });
  }
});

describe("durable write boundary: completeAnalysis strategy (§18/§22)", () => {
  const VALID = {
    title: "A Clip",
    thumbnail: null,
    source: "example.invalid",
  };

  it("accepts direct and yt-dlp", () => {
    for (const extractor of ["direct", "yt-dlp"]) {
      assert.equal(
        CompleteAnalysisInputSchema.safeParse({ ...VALID, extractor }).success,
        true,
        `${extractor} must be writable`,
      );
    }
  });

  it("rejects every arbitrary strategy string", () => {
    for (const extractor of [
      "Youtube",
      "generic",
      "evil",
      "upstream_extractor_key",
      "yt_dlp",
      "",
      "direct;drop",
    ]) {
      assert.equal(
        CompleteAnalysisInputSchema.safeParse({ ...VALID, extractor }).success,
        false,
        `${JSON.stringify(extractor)} must not be persistable as a strategy`,
      );
    }
  });
});

describe("durable round trip through the real SQLite store (§20/§22)", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  function seed(formatId: (typeof WORKER_REQUESTED_FORMAT_IDS)[number]) {
    const created = store.createJob(
      { url: "https://example.invalid/watch/abc", formatId, principalId: "private-access-user" },
      randomUUID(),
    );
    assert.equal(created.type, "created");
    const job = store.claimNextQueuedJob();
    assert.ok(job);
    return job;
  }

  it("a queued job hydrates with a null extractor before analysis completes", () => {
    const created = store.createJob(
      {
        url: "https://example.invalid/watch/abc",
        formatId: "direct-original",
        principalId: "private-access-user",
      },
      randomUUID(),
    );
    assert.equal(created.type, "created");
    if (created.type !== "created") return;
    const view = store.getJob(created.job.jobId);
    assert.equal(view?.extractor, null, "no strategy has been selected yet");
    assert.equal(view?.status, "queued");
  });

  it("persists and retrieves the DIRECT strategy", () => {
    const job = seed("direct-original");
    const res = store.completeAnalysis(job.jobId, {
      title: "A Clip",
      thumbnail: null,
      source: "cdn.example.invalid",
      extractor: "direct",
    });
    assert.equal(res.type, "updated");

    assert.equal(store.getJob(job.jobId)?.extractor, "direct");
    // ...and it round-trips through a fresh hydration of the same row.
    assert.equal(new SQLiteJobStore({ db }).getJob(job.jobId)?.extractor, "direct");
  });

  it("persists and retrieves the YT-DLP strategy", () => {
    const job = seed("preset:1080");
    const res = store.completeAnalysis(job.jobId, {
      title: "A Generic Clip",
      thumbnail: null,
      source: "example.invalid",
      extractor: "yt-dlp",
    });
    assert.equal(res.type, "updated");

    assert.equal(store.getJob(job.jobId)?.extractor, "yt-dlp");
    assert.equal(new SQLiteJobStore({ db }).getJob(job.jobId)?.extractor, "yt-dlp");
  });

  it("refuses to persist an arbitrary strategy through the real store", () => {
    const job = seed("preset:720");
    assert.throws(
      () =>
        store.completeAnalysis(job.jobId, {
          title: "A Clip",
          thumbnail: null,
          source: "example.invalid",
          // Exactly the shape of an upstream `extractor_key`.
          extractor: "Youtube" as never,
        }),
      "an upstream extractor name must never reach durable strategy state",
    );
    // The row is untouched.
    assert.equal(store.getJob(job.jobId)?.extractor, null);
  });

  it("every application format id survives a real create/claim round trip (§20)", () => {
    for (const formatId of WORKER_REQUESTED_FORMAT_IDS) {
      const fresh = new DatabaseSync(":memory:");
      applyMigrations(fresh);
      const s = new SQLiteJobStore({ db: fresh });
      const created = s.createJob(
        { url: "https://example.invalid/x", formatId, principalId: "private-access-user" },
        randomUUID(),
      );
      assert.equal(created.type, "created", `${formatId} must be creatable`);
      const claimed = s.claimNextQueuedJob();
      assert.equal(claimed?.formatId, formatId, `${formatId} must round trip`);
      fresh.close();
    }
  });

  it("a row carrying a raw upstream format id cannot be hydrated (§19/§21)", () => {
    const job = seed("preset:1080");
    // Reach past every write boundary, the way an older build or an out-of-band
    // edit could have.
    db.prepare("UPDATE worker_jobs SET format_id = ? WHERE job_id = ?").run("22", job.jobId);
    assert.throws(
      () => store.getJob(job.jobId),
      "a raw upstream format id must not become trusted execution state",
    );
  });

  it("no durable column ever holds a raw upstream source id (§19)", () => {
    const job = seed("preset:1080");
    store.completeAnalysis(job.jobId, {
      title: "A Generic Clip",
      thumbnail: null,
      source: "example.invalid",
      extractor: "yt-dlp",
    });

    // The whole row, serialized. The private `GenericSourceSelection.formatId`
    // is memory-only for one execution attempt and has no column at all.
    const raw = db
      .prepare("SELECT * FROM worker_jobs WHERE job_id = ?")
      .get(job.jobId) as Record<string, unknown>;
    assert.equal(raw.format_id, "preset:1080", "only the application preset is stored");
    assert.equal(raw.extractor, "yt-dlp", "only the closed strategy identity is stored");

    const columns = db
      .prepare("PRAGMA table_info(worker_jobs)")
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    for (const forbidden of ["source_format_id", "selector", "ytdlp_format", "raw_format_id"]) {
      assert.equal(names.includes(forbidden), false, `no ${forbidden} column may exist`);
    }
  });
});
