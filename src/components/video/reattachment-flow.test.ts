import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  ACTIVE_JOB_STORAGE_KEY,
  applyStoredJobDirective,
  readActiveJob,
  restoreActionFromStorage,
  writeActiveJob,
} from "@/lib/active-job-storage";
import { cancelDownload, getJobStatus, startDownload, type HistoryItem, type PolledJob } from "@/lib/client-api";
import { createCancelController, type CancelController } from "@/lib/download-cancel";
import {
  RESTORE_UNAVAILABLE_NOTICE,
  downloaderReducer,
  finishedJobForHistory,
  historyEntryForJob,
  initialDownloaderState,
  startStatusPollSession,
  statusPollTarget,
  type DownloaderAction,
  type DownloaderState,
  type StatusPollSession,
  type StoredJobDirective,
} from "@/lib/downloader-state";
import { ERROR_MESSAGES } from "@/lib/errors";
import { ACTIVITY_LABELS, WAITING_NOTICE_TITLE } from "@/lib/job-activity-ui";
import { CANCELLED_HEADING, DEFAULT_ERROR_HEADING, errorCardHeading } from "@/lib/job-failure-ui";
import { STATUS_POLL_RETRY_BUDGET_MS, type JobStatusPoller } from "@/lib/job-status-poller";
import { FakeClock, JOB_ID, OTHER_JOB_ID, polledJob } from "@/lib/job-status-poll.fixtures";

// Node strips types from .ts but cannot load .tsx; see
// source-quality-render.test.ts. The JSX is transpiled in-thread, only for the
// components imported below.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const { ProgressCard } = await import("./progress-card.tsx");
const { CompleteCard } = await import("./complete-card.tsx");
const { ErrorCard } = await import("./error-card.tsx");
const { JobSummary } = await import("./job-summary.tsx");
const { RestoringCard, RESTORING_TITLE } = await import("./restoring-card.tsx");
const { StatusConnectionNotice, RECONNECTING_TITLE, RETRY_EXHAUSTED_TITLE, RETRY_STATUS_LABEL } = await import(
  "./status-connection-notice.tsx"
);

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001 — reload
 * reattachment, end to end minus the DOM (the real browser run is in the
 * review kit).
 *
 * `Page` stands in for the route exactly as `status-poll-recovery.test.ts`
 * does, plus the two LD-4b effects through the SAME helpers the route calls:
 * `restoreActionFromStorage` once after mounting, and `applyStoredJobDirective`
 * whenever the reducer's directive changes. The REAL client functions, poll
 * loop, reducer, cancel controller and cards do the rest; only `fetch` and the
 * tab's storage are doubles. Every request is counted, so "a reload never
 * creates a job" is asserted, not assumed.
 */

type WireStep = { latencyMs?: number } & ({ status: number; body: unknown } | { reject: true });

const ok = (job: PolledJob): WireStep => ({ status: 200, body: job });
const failure = (code: keyof typeof ERROR_MESSAGES, status: number): WireStep => ({
  status,
  body: { success: false, error: { code, message: ERROR_MESSAGES[code] } },
});
const NETWORK_DROP: WireStep = { reject: true };

const downloadingWith = (activity: PolledJob["activity"], overrides: Partial<PolledJob> = {}) =>
  polledJob("downloading", { activity, createdAt: Date.now() - 95_000, expiresAt: Date.now() + 5_000_000, ...overrides });

class Wire {
  readonly statusCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  createCalls = 0;
  unscripted = 0;
  inFlight = 0;
  maxInFlight = 0;
  cancelAnswer: WireStep | null = null;
  private readonly clock: FakeClock;
  private readonly steps: WireStep[];
  private readonly fallback: WireStep | null;

  constructor(clock: FakeClock, steps: WireStep[], fallback: WireStep | null = null) {
    this.clock = clock;
    this.steps = [...steps];
    this.fallback = fallback;
  }

  push(...steps: WireStep[]) {
    this.steps.push(...steps);
  }

  private answer(step: WireStep, init?: RequestInit, onEnd: () => void = () => {}): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const end = (fn: () => void) => {
        if (done) return;
        done = true;
        onEnd();
        fn();
      };
      init?.signal?.addEventListener("abort", () =>
        end(() => reject(new DOMException("The operation was aborted.", "AbortError"))),
      );
      const reply = () =>
        end(() => {
          if ("reject" in step) reject(new TypeError("Failed to fetch"));
          else resolve(Response.json(step.body, { status: step.status }));
        });
      if (step.latencyMs) this.clock.setTimeout(reply, step.latencyMs);
      else queueMicrotask(reply);
    });
  }

  readonly fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST" && input === "/api/download") {
      this.createCalls += 1;
      return Response.json(polledJob("queued", { jobId: OTHER_JOB_ID, progress: null, stageLabel: "Queued" }));
    }
    const cancel = /^\/api\/download\/([0-9a-f]{32})\/cancel$/.exec(input);
    if (cancel && init?.method === "POST") {
      this.cancelCalls.push(cancel[1]);
      const step = this.cancelAnswer ?? { reject: true };
      return this.answer(step, init);
    }
    const match = /^\/api\/download\/([0-9a-f]{32})\/status$/.exec(input);
    assert.ok(match, `unexpected request ${init?.method ?? "GET"} ${input}`);
    assert.equal(init?.method ?? "GET", "GET", "a status read is a GET");
    this.statusCalls.push(match[1]);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const step = this.steps.shift() ?? this.fallback;
    if (!step) {
      this.unscripted += 1;
      this.inFlight -= 1;
      throw new TypeError("unscripted status request");
    }
    return this.answer(step, init, () => {
      this.inFlight -= 1;
    });
  }) as typeof fetch;
}

/** The tab's `sessionStorage`. */
class TabStorage implements Storage {
  readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  /** Duplicating a tab copies its session storage. */
  copy(): TabStorage {
    const twin = new TabStorage();
    for (const [k, v] of this.map) twin.map.set(k, v);
    return twin;
  }
}

class Page {
  state: DownloaderState = initialDownloaderState;
  pollersStarted = 0;
  private poller: JobStatusPoller | null = null;
  private pollKey: { jobId: string; session: StatusPollSession } | null = null;
  private lastStored: StoredJobDirective = initialDownloaderState.stored;
  private lastFinished: PolledJob | null = null;
  private mounted = true;
  readonly cancel: CancelController;
  private readonly clock: FakeClock;
  readonly storage: TabStorage;
  readonly history: { items: HistoryItem[] };

  constructor(clock: FakeClock, storage: TabStorage, history: { items: HistoryItem[] } = { items: [] }) {
    this.clock = clock;
    this.storage = storage;
    this.history = history;
    this.cancel = createCancelController({
      getState: () => this.state,
      dispatch: this.dispatch,
      cancel: (id, signal) => cancelDownload(id, { signal }),
      clock,
    });
  }

  readonly dispatch = (action: DownloaderAction) => {
    if (!this.mounted) return;
    this.state = downloaderReducer(this.state, action);
    queueMicrotask(() => this.runEffects());
  };

  /**
   * The route's mount: the restore effect, once — or, under React's
   * development double effects, mount → cleanup → mount (`strict`).
   */
  async mount({ strict = false } = {}) {
    const restore = restoreActionFromStorage(this.storage);
    if (restore) this.dispatch(restore);
    if (strict) {
      await Promise.resolve();
      this.runEffects();
      this.poller?.stop();
      this.poller = null;
      this.pollKey = null;
      const again = restoreActionFromStorage(this.storage);
      if (again) this.dispatch(again);
      queueMicrotask(() => this.runEffects());
    }
    await this.clock.advance(0);
  }

  private runEffects() {
    if (!this.mounted) return;
    if (this.state.stored !== this.lastStored) {
      this.lastStored = this.state.stored;
      applyStoredJobDirective(this.state.stored, this.storage);
    }
    const target = statusPollTarget(this.state);
    if (target?.jobId !== this.pollKey?.jobId || target?.session !== this.pollKey?.session) {
      this.poller?.stop();
      this.poller = null;
      this.pollKey = target;
      if (target) {
        this.pollersStarted += 1;
        this.poller = startStatusPollSession(target, this.dispatch, (id, signal) => getJobStatus(id, { signal }), this.clock);
      }
    }
    const finished = finishedJobForHistory(this.state);
    if (finished && finished !== this.lastFinished) {
      const recorded = this.history.items.some((h) => h.jobId === finished.jobId && h.status === finished.status);
      if (!recorded) {
        const entry = historyEntryForJob(finished, null, this.clock.now());
        this.history.items = [entry, ...this.history.items.filter((h) => h.jobId !== entry.jobId)];
      }
    }
    this.lastFinished = finished;
  }

  async download() {
    this.dispatch({ type: "analyze_started" });
    this.dispatch({ type: "analyze_succeeded" });
    this.dispatch({ type: "download_requested" });
    const created = await startDownload({ url: "https://youtu.be/S_XfAWeXRFQ", formatId: "preset:1080" });
    this.dispatch({ type: "download_started", job: created });
    await this.clock.advance(0);
  }

  reset() {
    this.dispatch({ type: "reset" });
  }

  retryStatus() {
    this.dispatch({ type: "retry_status" });
  }

  unmount() {
    this.poller?.stop();
    this.poller = null;
    this.cancel.dispose();
    this.mounted = false;
  }

  /** The job region with the route's own conditions (no analysis on a restored page). */
  render(): string {
    const { phase, job, error, connectivity, notice } = this.state;
    const noop = () => {};
    const parts: ReactElement[] = [];
    if (phase === "idle" && notice) parts.push(createElement("p", { key: "notice", role: "status" }, notice));
    if (phase === "restoring") {
      parts.push(createElement(RestoringCard, { key: "r", connectivity, onRetryStatus: noop, onReset: noop }));
    }
    if (phase === "error" && error) {
      parts.push(createElement(ErrorCard, { key: "e", heading: errorCardHeading(job), message: error, onReset: noop }));
    }
    if ((phase === "processing" || phase === "complete") && job) {
      parts.push(createElement(JobSummary, { key: "s", job }));
      if (phase === "processing") {
        parts.push(createElement(ProgressCard, { key: "p", job, connectivity }));
        parts.push(createElement(StatusConnectionNotice, { key: "n", connectivity, onRetryStatus: noop, onReset: noop }));
      } else {
        parts.push(createElement(CompleteCard, { key: "c", job, onReset: noop }));
      }
    }
    return renderToStaticMarkup(createElement(Fragment, null, ...parts));
  }
}

const originalFetch = globalThis.fetch;
const pages: Page[] = [];
afterEach(() => {
  for (const page of pages.splice(0)) page.unmount();
  globalThis.fetch = originalFetch;
});

const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

/** A tab whose previous page stored `jobId`, and a fresh page in it. */
function reloadInto(steps: WireStep[], options: { fallback?: WireStep | null; stored?: string | null; storage?: TabStorage } = {}) {
  const clock = new FakeClock();
  const wire = new Wire(clock, steps, options.fallback ?? null);
  globalThis.fetch = wire.fetch;
  const storage = options.storage ?? new TabStorage();
  if (options.stored !== null && !options.storage) writeActiveJob(options.stored ?? JOB_ID, storage);
  const page = new Page(clock, storage);
  pages.push(page);
  return { clock, wire, page, storage };
}

const storedJobId = (storage: TabStorage) => {
  const read = readActiveJob(storage);
  return read.kind === "job" ? read.jobId : read.kind;
};

describe("reload during a running job: the SAME job, by one status read — never a new job", () => {
  it("during acquisition: restores the job, its activity and its card, and keeps polling", async () => {
    const { clock, wire, page, storage } = reloadInto(
      [ok(downloadingWith({ state: "waiting", elapsedSeconds: 70, limitSeconds: 600, idleSeconds: 24 }))],
      { fallback: ok(downloadingWith({ state: "receiving", elapsedSeconds: 71, limitSeconds: 600, idleSeconds: 0 })) },
    );
    await page.mount();
    assert.equal(page.state.phase, "processing");
    assert.equal(page.state.job?.jobId, JOB_ID);
    assert.deepEqual(wire.statusCalls, [JOB_ID], "one immediate status read");
    assert.equal(wire.createCalls, 0, "no job is created");
    const html = decode(page.render());
    assert.ok(html.includes(ACTIVITY_LABELS.waiting));
    assert.ok(html.includes(WAITING_NOTICE_TITLE), "24 s without new data: the waiting notice");
    assert.ok(html.includes("Download time limit") && html.includes("10 min"));
    assert.ok(html.includes("Regression clip"), "the job's own title, without an analysis");
    await clock.advance(2_000);
    assert.equal(page.state.job?.activity?.state, "receiving");
    assert.equal(decode(page.render()).includes(WAITING_NOTICE_TITLE), false, "progress again: no notice");
    assert.equal(wire.maxInFlight, 1);
    assert.equal(page.pollersStarted, 1);
    assert.equal(wire.createCalls, 0);
    assert.equal(storedJobId(storage), JOB_ID);
  });

  it("during processing and uploading: the download is shown as complete, and polling continues to ready", async () => {
    const { clock, wire, page, storage } = reloadInto([
      ok(polledJob("processing", { stageLabel: "Processing" })),
      ok(polledJob("uploading", { stageLabel: "Finalizing" })),
      ok(polledJob("ready")),
    ]);
    await page.mount();
    assert.equal(page.state.phase, "processing");
    assert.ok(decode(page.render()).includes("Download complete. Preparing the file"));
    await clock.advance(1_000);
    assert.ok(decode(page.render()).includes("Download complete. Finishing up"));
    await clock.advance(1_000);
    assert.equal(page.state.phase, "complete");
    assert.ok(decode(page.render()).includes(`/api/download/${JOB_ID}/file`));
    assert.equal(wire.createCalls, 0);
    assert.equal(storedJobId(storage), JOB_ID, "a reload shows the ready file again");
  });

  it("during a tunnel outage: the job is kept and the page keeps asking, with no error card", async () => {
    const { clock, wire, page } = reloadInto(
      [
        failure("WORKER_UNAVAILABLE", 503),
        NETWORK_DROP,
        { status: 500, body: { success: false, error: { code: "PROCESSING_FAILED", message: "x" } } },
      ],
      { fallback: ok(downloadingWith(null)) },
    );
    await page.mount();
    assert.equal(page.state.phase, "restoring");
    assert.equal(page.state.connectivity, "reconnecting");
    let html = decode(page.render());
    assert.ok(html.includes(RESTORING_TITLE) && html.includes(RECONNECTING_TITLE));
    assert.equal(html.includes(DEFAULT_ERROR_HEADING), false);
    await clock.advance(10_000);
    assert.equal(page.state.phase, "processing");
    assert.equal(page.state.connectivity, "connected");
    html = decode(page.render());
    assert.equal(html.includes(ACTIVITY_LABELS.receiving), false, "an older Worker's status: no activity line");
    assert.equal(wire.createCalls, 0);
    assert.equal(wire.maxInFlight, 1);
    assert.equal(wire.unscripted, 0);
  });

  it("an outage that outlasts the budget offers Retry status, which reads the same job again", async () => {
    const { clock, wire, page, storage } = reloadInto([], { fallback: failure("WORKER_UNAVAILABLE", 503) });
    await page.mount();
    await clock.advance(STATUS_POLL_RETRY_BUDGET_MS + 10_000);
    assert.equal(page.state.phase, "restoring");
    assert.equal(page.state.connectivity, "retry_exhausted");
    const html = decode(page.render());
    assert.ok(html.includes(RETRY_EXHAUSTED_TITLE) && html.includes(RETRY_STATUS_LABEL));
    assert.equal(storedJobId(storage), JOB_ID, "an unreachable Worker never discards the job");
    const before = wire.statusCalls.length;
    wire.push(ok(downloadingWith(null)));
    page.retryStatus();
    await clock.advance(0);
    assert.equal(wire.statusCalls.length, before + 1);
    assert.equal(page.state.phase, "processing");
    assert.equal(wire.createCalls, 0);
  });
});

describe("reload after the job ended: its outcome, from the Worker", () => {
  it("after ready: the file, no polling, and history is not rewritten", async () => {
    const history = { items: [] as HistoryItem[] };
    const clock = new FakeClock();
    const wire = new Wire(clock, [ok(polledJob("ready")), ok(polledJob("ready"))]);
    globalThis.fetch = wire.fetch;
    const storage = new TabStorage();
    writeActiveJob(JOB_ID, storage);
    for (let reload = 0; reload < 2; reload += 1) {
      const page = new Page(clock, storage, history);
      pages.push(page);
      await page.mount();
      assert.equal(page.state.phase, "complete");
      await clock.advance(5_000);
      page.unmount();
    }
    assert.deepEqual(wire.statusCalls, [JOB_ID, JOB_ID], "one read per reload, then nothing");
    assert.equal(history.items.length, 1);
    assert.equal(wire.createCalls, 0);
  });

  it("after a failure: the failure with its heading; Try again is not offered without an analysis", async () => {
    const { page } = reloadInto([
      ok(polledJob("failed", { errorCode: "TIMEOUT", stageLabel: "Download stalled", error: "The source stopped sending data." })),
    ]);
    await page.mount();
    assert.equal(page.state.phase, "error");
    const html = decode(page.render());
    assert.ok(html.includes("Download stalled"));
    assert.ok(html.includes("The source stopped sending data."));
  });

  it("after a cancellation: shown as cancelled", async () => {
    const { page } = reloadInto([ok(polledJob("cancelled", { stageLabel: "Cancelled" }))]);
    await page.mount();
    assert.equal(page.state.phase, "error");
    assert.ok(decode(page.render()).includes(CANCELLED_HEADING));
  });
});

describe("stale and foreign entries", () => {
  it("an unknown job: a short note, the entry forgotten, nothing else sent", async () => {
    const { wire, page, storage } = reloadInto([failure("NOT_FOUND", 404)]);
    await page.mount();
    assert.equal(page.state.phase, "idle");
    assert.equal(page.state.notice, RESTORE_UNAVAILABLE_NOTICE);
    assert.ok(decode(page.render()).includes(RESTORE_UNAVAILABLE_NOTICE));
    assert.equal(storedJobId(storage), "none");
    assert.equal(wire.statusCalls.length, 1);
    assert.equal(wire.createCalls, 0);
  });

  it("an expired job: the same", async () => {
    const { page, storage } = reloadInto([failure("EXPIRED", 410)]);
    await page.mount();
    assert.equal(page.state.notice, RESTORE_UNAVAILABLE_NOTICE);
    assert.equal(storedJobId(storage), "none");
  });

  it("access refused: shown as such; the entry is left to the access lifecycle", async () => {
    const { page, storage, wire } = reloadInto([failure("ACCESS_REQUIRED", 401)]);
    await page.mount();
    assert.equal(page.state.phase, "error");
    assert.equal(page.state.error, ERROR_MESSAGES.ACCESS_REQUIRED);
    assert.equal(storedJobId(storage), JOB_ID);
    assert.equal(wire.createCalls, 0);
  });

  it("a malformed, unsupported or foreign-shaped entry is removed and nothing is sent", async () => {
    for (const raw of [
      "{not json",
      JSON.stringify({ v: 2, jobId: JOB_ID }),
      JSON.stringify({ v: 1, jobId: "NOT-A-JOB" }),
      JSON.stringify({ v: 1, jobId: JOB_ID, url: "https://cdn.example/clip.mp4" }),
    ]) {
      const storage = new TabStorage();
      storage.setItem(ACTIVE_JOB_STORAGE_KEY, raw);
      const { wire, page } = reloadInto([], { storage });
      await page.mount();
      assert.equal(page.state.phase, "idle", raw);
      assert.equal(storage.getItem(ACTIVE_JOB_STORAGE_KEY), null, raw);
      assert.equal(wire.statusCalls.length + wire.createCalls, 0, raw);
    }
  });

  it("an entry naming a job this browser never created is only READ: the server decides", async () => {
    const { wire, page } = reloadInto([failure("NOT_FOUND", 404)], { stored: OTHER_JOB_ID });
    await page.mount();
    assert.deepEqual(wire.statusCalls, [OTHER_JOB_ID]);
    assert.equal(wire.createCalls + wire.cancelCalls.length, 0);
  });

  it("no entry: nothing is sent at all", async () => {
    const { wire, page } = reloadInto([], { stored: null });
    await page.mount();
    assert.equal(page.state.phase, "idle");
    assert.equal(wire.statusCalls.length + wire.createCalls, 0);
  });
});

describe("races", () => {
  it("React's double mount effect starts one session: one request in flight, one poller left running", async () => {
    const { clock, wire, page } = reloadInto([{ ...ok(downloadingWith(null)), latencyMs: 300 }], {
      fallback: ok(downloadingWith(null)),
    });
    await page.mount({ strict: true });
    await clock.advance(5_000);
    assert.equal(page.state.phase, "processing");
    assert.equal(wire.maxInFlight, 1);
    assert.equal(wire.createCalls, 0);
    const callsAt = wire.statusCalls.length;
    await clock.advance(800);
    assert.equal(wire.statusCalls.length - callsAt, 1, "exactly one loop polls the restored job");
  });

  it("a status answer for the restore that arrives after Start over changes nothing", async () => {
    const { clock, page, storage } = reloadInto([{ ...ok(downloadingWith(null)), latencyMs: 1_000 }]);
    await page.mount();
    page.reset();
    await clock.advance(2_000);
    assert.equal(page.state.phase, "idle");
    assert.equal(page.state.job, null);
    assert.equal(storedJobId(storage), "none", "Start over forgets the job");
  });

  it("an earlier job's late answer cannot overwrite a newer job", async () => {
    const { clock, wire, page, storage } = reloadInto(
      [{ ...ok(downloadingWith(null)), latencyMs: 5_000 }],
      { fallback: ok(polledJob("downloading", { jobId: OTHER_JOB_ID })) },
    );
    await page.mount();
    page.reset();
    await page.download();
    assert.equal(page.state.job?.jobId, OTHER_JOB_ID);
    await clock.advance(6_000);
    assert.equal(page.state.job?.jobId, OTHER_JOB_ID);
    assert.equal(storedJobId(storage), OTHER_JOB_ID, "the new job replaced the old id");
    assert.equal(wire.createCalls, 1, "only the person's own Download created a job");
  });

  it("repeated reloads: each reads the job once more, none creates or cancels", async () => {
    const clock = new FakeClock();
    const wire = new Wire(clock, [], ok(downloadingWith(null)));
    globalThis.fetch = wire.fetch;
    const storage = new TabStorage();
    writeActiveJob(JOB_ID, storage);
    for (let reload = 0; reload < 5; reload += 1) {
      const page = new Page(clock, storage);
      pages.push(page);
      await page.mount();
      assert.equal(page.state.phase, "processing");
      page.unmount();
    }
    assert.equal(wire.statusCalls.length, 5);
    assert.equal(wire.createCalls + wire.cancelCalls.length, 0);
  });

  it("a duplicated tab copies the entry: each tab follows the same job with its own single loop", async () => {
    const clock = new FakeClock();
    const wire = new Wire(clock, [], ok(downloadingWith(null)));
    globalThis.fetch = wire.fetch;
    const first = new TabStorage();
    writeActiveJob(JOB_ID, first);
    const a = new Page(clock, first);
    const b = new Page(clock, first.copy());
    pages.push(a, b);
    await a.mount();
    await b.mount();
    assert.equal(a.state.job?.jobId, JOB_ID);
    assert.equal(b.state.job?.jobId, JOB_ID);
    assert.equal(a.pollersStarted + b.pollersStarted, 2);
    assert.equal(wire.createCalls, 0);
  });
});

describe("cancellation after reattachment", () => {
  it("the restored job's Cancel cancels THAT job, once, and the page shows what the Worker committed", async () => {
    const { clock, wire, page } = reloadInto([ok(downloadingWith(null))], { fallback: ok(downloadingWith(null)) });
    await page.mount();
    wire.cancelAnswer = ok(polledJob("cancelled", { stageLabel: "Cancelled" }));
    page.cancel.request(JOB_ID);
    page.cancel.request(JOB_ID);
    await clock.advance(0);
    assert.deepEqual(wire.cancelCalls, [JOB_ID]);
    assert.equal(page.state.phase, "error");
    assert.equal(page.state.job?.status, "cancelled");
  });

  it("a reload never resends a cancellation, nor treats an unconfirmed one as confirmed", async () => {
    const { clock, wire, page, storage } = reloadInto([ok(downloadingWith(null))], { fallback: ok(downloadingWith(null)) });
    await page.mount();
    wire.cancelAnswer = NETWORK_DROP;
    page.cancel.request(JOB_ID);
    await clock.advance(0);
    assert.equal(page.state.cancel.kind, "unconfirmed");
    page.unmount();
    const again = new Page(clock, storage);
    pages.push(again);
    await again.mount();
    await clock.advance(3_000);
    assert.equal(again.state.phase, "processing", "still running, as the Worker says");
    assert.equal(again.state.cancel.kind, "idle", "nothing about the earlier request is carried over");
    assert.deepEqual(wire.cancelCalls, [JOB_ID], "the cancellation was sent once, by the person");
  });

  it("a late cancellation answer cannot overwrite a ready job", async () => {
    const { clock, wire, page } = reloadInto([ok(downloadingWith(null)), ok(polledJob("ready"))]);
    await page.mount();
    wire.cancelAnswer = { ...ok(polledJob("cancelled")), latencyMs: 2_000 };
    page.cancel.request(JOB_ID);
    await clock.advance(1_000);
    assert.equal(page.state.phase, "complete");
    await clock.advance(2_000);
    assert.equal(page.state.phase, "complete", "ready stays ready");
    assert.equal(page.state.job?.status, "ready");
  });
});
