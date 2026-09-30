import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { getJobStatus, startDownload, type HistoryItem, type PolledJob } from "@/lib/client-api";
import {
  downloaderReducer,
  finishedJobForHistory,
  historyEntryForJob,
  initialDownloaderState,
  startStatusPollSession,
  statusPollTarget,
  type DownloaderAction,
  type DownloaderState,
  type StatusPollSession,
} from "@/lib/downloader-state";
import { ERROR_MESSAGES } from "@/lib/errors";
import { DEFAULT_ERROR_HEADING, errorCardHeading } from "@/lib/job-failure-ui";
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
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const { ProgressCard } = await import("./progress-card.tsx");
const { CompleteCard } = await import("./complete-card.tsx");
const { ErrorCard } = await import("./error-card.tsx");
const {
  StatusConnectionNotice,
  RECONNECTING_TITLE,
  RETRY_EXHAUSTED_TITLE,
  RETRY_STATUS_LABEL,
  STILL_RUNNING_MESSAGE,
} = await import("./status-connection-notice.tsx");

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: the downloader end to end, minus the
 * DOM. The status endpoint is a mocked `fetch` answering with real wire
 * responses; the REAL `getJobStatus`, poll loop, reducer and cards do the rest.
 *
 * `Page` stands in for the route: it owns the reducer state, runs the polling
 * session through the same `startStatusPollSession` the route's effect uses —
 * restarting it only when `statusPollTarget`'s job or session changes, as the
 * effect's dependencies do — records history from `finishedJobForHistory`, and
 * renders the job region with the route's own conditions and components.
 */

type WireStep = { latencyMs?: number } & (
  | { status: number; body: unknown }
  | { html: string; status: number }
  | { reject: true }
);

const ok = (job: PolledJob): WireStep => ({ status: 200, body: job });
const failure = (code: keyof typeof ERROR_MESSAGES, status: number): WireStep => ({
  status,
  body: { success: false, error: { code, message: ERROR_MESSAGES[code] } },
});
const WORKER_503 = failure("WORKER_UNAVAILABLE", 503);
const NETWORK_DROP: WireStep = { reject: true };

class Wire {
  statusCalls: string[] = [];
  createCalls = 0;
  unscripted = 0;
  inFlight = 0;
  maxInFlight = 0;
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

  readonly fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST" && input === "/api/download") {
      this.createCalls += 1;
      return Response.json(polledJob("queued", { jobId: this.nextCreatedJobId, progress: null, stageLabel: "Queued" }));
    }
    const match = /^\/api\/download\/([0-9a-f]{32})\/status$/.exec(input);
    assert.ok(match, `unexpected request ${input}`);
    this.statusCalls.push(match[1]);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const step = this.steps.shift() ?? this.fallback;
    if (!step) {
      // Polled more often than scripted. Counted rather than thrown: a throw
      // here would only surface to the loop as one more network failure.
      this.unscripted += 1;
      this.inFlight -= 1;
      throw new TypeError("unscripted status request");
    }
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const end = (fn: () => void) => {
        if (done) return;
        done = true;
        this.inFlight -= 1;
        fn();
      };
      init?.signal?.addEventListener("abort", () =>
        end(() => reject(new DOMException("The operation was aborted.", "AbortError"))),
      );
      const answer = () =>
        end(() => {
          if ("reject" in step) reject(new TypeError("Failed to fetch"));
          else if ("html" in step)
            resolve(new Response(step.html, { status: step.status, headers: { "Content-Type": "text/html" } }));
          else resolve(Response.json(step.body, { status: step.status }));
        });
      if (step.latencyMs) this.clock.setTimeout(answer, step.latencyMs);
      else queueMicrotask(answer);
    });
  }) as typeof fetch;

  nextCreatedJobId = JOB_ID;
}

class Page {
  state: DownloaderState = initialDownloaderState;
  history: HistoryItem[] = [];
  pollersStarted = 0;
  private poller: JobStatusPoller | null = null;
  private pollKey: { jobId: string; session: StatusPollSession } | null = null;
  private lastFinished: PolledJob | null = null;
  private mounted = true;
  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  readonly dispatch = (action: DownloaderAction) => {
    if (!this.mounted) return;
    this.state = downloaderReducer(this.state, action);
    // Effects run after the render, not inside the dispatch.
    queueMicrotask(() => this.runEffects());
  };

  private runEffects() {
    if (!this.mounted) return;
    const target = statusPollTarget(this.state);
    if (target?.jobId !== this.pollKey?.jobId || target?.session !== this.pollKey?.session) {
      this.poller?.stop();
      this.poller = null;
      this.pollKey = target;
      if (target) {
        this.pollersStarted += 1;
        this.poller = startStatusPollSession(
          target,
          this.dispatch,
          (id, signal) => getJobStatus(id, { signal }),
          this.clock,
        );
      }
    }
    const finished = finishedJobForHistory(this.state);
    if (finished && finished !== this.lastFinished) {
      const entry = historyEntryForJob(finished, { title: "Analyzed title", thumbnail: null }, this.clock.now());
      this.history = [entry, ...this.history.filter((h) => h.jobId !== entry.jobId)];
    }
    this.lastFinished = finished;
  }

  /** The route's handleDownload, through the real client. */
  async download() {
    this.dispatch({ type: "analyze_started" });
    this.dispatch({ type: "analyze_succeeded" });
    this.dispatch({ type: "download_requested" });
    const created = await startDownload({ url: "https://youtu.be/S_XfAWeXRFQ", formatId: "preset:1080" });
    this.dispatch({ type: "download_started", job: created });
    await this.clock.advance(0);
  }

  retryStatus() {
    this.dispatch({ type: "retry_status" });
  }

  reset() {
    this.dispatch({ type: "reset" });
  }

  unmount() {
    this.poller?.stop();
    this.poller = null;
    this.mounted = false;
  }

  /** The job region exactly as the route renders it. */
  render(): string {
    const { phase, job, error, connectivity } = this.state;
    const noop = () => {};
    const parts: ReactElement[] = [];
    if (phase === "error" && error) {
      parts.push(createElement(ErrorCard, { key: "e", heading: errorCardHeading(job), message: error, onReset: noop }));
    }
    if (phase === "processing" && job) {
      parts.push(createElement(ProgressCard, { key: "p", job }));
      parts.push(
        createElement(StatusConnectionNotice, { key: "n", connectivity, onRetryStatus: noop, onReset: noop }),
      );
    }
    if (phase === "complete" && job) {
      parts.push(createElement(CompleteCard, { key: "c", job, onReset: noop }));
    }
    return renderToStaticMarkup(createElement(Fragment, null, ...parts));
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setup(steps: WireStep[], fallback: WireStep | null = null) {
  const clock = new FakeClock();
  const wire = new Wire(clock, steps, fallback);
  globalThis.fetch = wire.fetch;
  const page = new Page(clock);
  return { clock, wire, page };
}

const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

function assertReconnecting(html: string) {
  const text = decode(html);
  assert.ok(text.includes(RECONNECTING_TITLE), "the reconnecting indicator is shown");
  assert.ok(text.includes(STILL_RUNNING_MESSAGE));
  assert.equal(text.includes(DEFAULT_ERROR_HEADING), false, "no 'We hit a snag'");
  assert.equal(text.includes("Failed to fetch"), false);
}

describe("a status outage in the middle of a download recovers to ready", () => {
  it("200 downloading → 503 → network drop → 503 → 200 processing → 200 ready", async () => {
    const { clock, wire, page } = setup([
      ok(polledJob("downloading", { progress: 42, stageLabel: "Downloading" })),
      WORKER_503,
      NETWORK_DROP,
      WORKER_503,
      ok(polledJob("processing", { progress: 100, stageLabel: "Processing" })),
      ok(polledJob("ready")),
    ]);

    await page.download();
    assert.ok(decode(page.render()).includes("Queued"));

    await clock.advance(800);
    let html = decode(page.render());
    assert.ok(html.includes("Downloading") && html.includes("42%"));
    assert.equal(html.includes(RECONNECTING_TITLE), false);

    // 503 WORKER_UNAVAILABLE: reconnecting, last known progress kept.
    await clock.advance(800);
    html = page.render();
    assertReconnecting(html);
    assert.ok(html.includes("42%"), "the last known progress stays on screen");
    assert.equal(page.state.phase, "processing");
    assert.equal(page.state.job?.jobId, JOB_ID);
    assert.equal(page.state.job?.title, "Regression clip");
    assert.equal(page.state.job?.thumbnail, "https://img.example/thumb.jpg");

    // Network rejection (after 800 ms), then 503 again (after 1.5 s).
    await clock.advance(800);
    assertReconnecting(page.render());
    await clock.advance(1_500);
    assertReconnecting(page.render());
    assert.equal(page.history.length, 0);

    // 200 processing (after 3 s): the indicator clears.
    await clock.advance(3_000);
    html = decode(page.render());
    assert.equal(html.includes(RECONNECTING_TITLE), false);
    assert.ok(html.includes("Processing"));

    // 200 ready.
    await clock.advance(800);
    html = decode(page.render());
    assert.equal(page.state.phase, "complete");
    assert.ok(html.includes("Your video is ready"));
    assert.ok(html.includes(`href="/api/download/${JOB_ID}/file"`));
    assert.ok(html.includes("clip.mp4") && html.includes("1080") && html.includes("MP4"));
    assert.equal(html.includes(RECONNECTING_TITLE), false, "no stale reconnect notice");
    assert.equal(html.includes(DEFAULT_ERROR_HEADING), false);

    assert.equal(page.history.length, 1);
    assert.equal(page.history[0].status, "ready");
    assert.equal(page.history[0].jobId, JOB_ID);
    assert.equal(page.history[0].title, "Regression clip");
    assert.equal(wire.createCalls, 1, "the media job was submitted exactly once");
    assert.deepEqual(new Set(wire.statusCalls), new Set([JOB_ID]));
    assert.equal(wire.statusCalls.length, 6);
    assert.equal(wire.maxInFlight, 1);
    assert.equal(page.pollersStarted, 1);

    await clock.advance(600_000);
    assert.equal(wire.statusCalls.length, 6, "polling stopped at ready");
    assert.equal(wire.unscripted, 0);
  });

  it("recovers from 500 PROCESSING_FAILED and a 502 edge page with no envelope", async () => {
    const { clock, wire, page } = setup([
      failure("PROCESSING_FAILED", 500),
      { html: "<html>502 Bad Gateway</html>", status: 502 },
      ok(polledJob("ready")),
    ]);
    await page.download();
    await clock.advance(800);
    assertReconnecting(page.render());
    await clock.advance(800);
    assertReconnecting(page.render());
    assert.ok(decode(page.render()).includes("Preparing your video"));
    await clock.advance(1_500);
    assert.equal(page.state.phase, "complete");
    assert.equal(wire.createCalls, 1);
  });

  it("never overlaps status requests while the endpoint is slow", async () => {
    const { clock, wire, page } = setup([
      { ...ok(polledJob("downloading")), latencyMs: 3_000 },
      { ...WORKER_503, latencyMs: 9_000 },
      { ...NETWORK_DROP, latencyMs: 4_000 },
      { ...ok(polledJob("ready")), latencyMs: 2_000 },
    ]);
    await page.download();
    await clock.advance(60_000);
    assert.equal(page.state.phase, "complete");
    assert.equal(wire.maxInFlight, 1);
    assert.equal(wire.statusCalls.length, 4);
  });
});

describe("a definitive answer stops polling", () => {
  it("200 downloading → 404 NOT_FOUND", async () => {
    const { clock, wire, page } = setup([
      ok(polledJob("downloading", { progress: 42 })),
      failure("NOT_FOUND", 404),
    ]);
    await page.download();
    await clock.advance(1_600);
    const html = decode(page.render());
    assert.equal(page.state.phase, "error");
    assert.ok(html.includes(DEFAULT_ERROR_HEADING));
    assert.ok(html.includes(ERROR_MESSAGES.NOT_FOUND));
    assert.equal(html.includes(RECONNECTING_TITLE), false);
    await clock.advance(600_000);
    assert.equal(wire.statusCalls.length, 2, "no retry after NOT_FOUND");
    assert.equal(wire.unscripted, 0);
    assert.equal(page.history.length, 0, "not recorded as a failed job");
    assert.equal(wire.createCalls, 1);
  });

  for (const [code, status] of [
    ["EXPIRED", 410],
    ["ACCESS_REQUIRED", 401],
  ] as const) {
    it(`${code} stops with its canonical copy`, async () => {
      const { clock, wire, page } = setup([failure(code, status)]);
      await page.download();
      await clock.advance(600_000);
      assert.equal(page.state.phase, "error");
      assert.ok(decode(page.render()).includes(ERROR_MESSAGES[code]));
      assert.equal(wire.statusCalls.length, 1);
      assert.equal(wire.unscripted, 0);
      assert.equal(page.history.length, 0);
    });
  }

  it("a failed job keeps the PR #101 stage heading and canonical message", async () => {
    const { clock, page } = setup([
      WORKER_503,
      ok(
        polledJob("failed", {
          errorCode: "PROCESSING_FAILED",
          error: ERROR_MESSAGES.PROCESSING_FAILED,
          stageLabel: "Processing failed",
        }),
      ),
    ]);
    await page.download();
    await clock.advance(800);
    assertReconnecting(page.render());
    await clock.advance(800);
    const html = decode(page.render());
    assert.ok(html.includes("Processing failed"));
    assert.ok(html.includes(ERROR_MESSAGES.PROCESSING_FAILED));
    assert.equal(html.includes(DEFAULT_ERROR_HEADING), false);
    assert.equal(html.includes(RECONNECTING_TITLE), false);
    assert.deepEqual(
      page.history.map((h) => h.status),
      ["failed"],
    );
  });
});

describe("an outage longer than the budget keeps the job and offers Retry status", () => {
  it("exhausts, keeps the job, then Retry status reaches ready on the same job", async () => {
    const { clock, wire, page } = setup([ok(polledJob("downloading", { progress: 37 }))], WORKER_503);
    await page.download();
    await clock.advance(STATUS_POLL_RETRY_BUDGET_MS + 30_000);

    const html = decode(page.render());
    assert.equal(page.state.phase, "processing");
    assert.equal(page.state.connectivity, "retry_exhausted");
    assert.equal(page.state.job?.jobId, JOB_ID, "the job id is kept");
    assert.ok(html.includes(RETRY_EXHAUSTED_TITLE));
    assert.ok(html.includes(STILL_RUNNING_MESSAGE));
    assert.ok(html.includes(`>${RETRY_STATUS_LABEL}<`));
    assert.ok(html.includes(">Start over<"));
    assert.ok(html.includes("37%"), "last known progress is still shown");
    assert.equal(html.includes(DEFAULT_ERROR_HEADING), false, "no fake Worker failure");
    assert.equal(page.history.length, 0, "nothing recorded as failed");

    const callsAtExhaustion = wire.statusCalls.length;
    await clock.advance(600_000);
    assert.equal(wire.statusCalls.length, callsAtExhaustion, "polling has stopped");

    // Double click: exactly one new loop, polling the SAME job at once.
    wire.push(ok(polledJob("ready")));
    page.retryStatus();
    page.retryStatus();
    await clock.advance(0);
    assert.equal(page.pollersStarted, 2);
    assert.equal(wire.statusCalls.length, callsAtExhaustion + 1);
    assert.equal(wire.statusCalls.at(-1), JOB_ID);

    const done = decode(page.render());
    assert.equal(page.state.phase, "complete");
    assert.ok(done.includes("Your video is ready"));
    assert.ok(done.includes(`href="/api/download/${JOB_ID}/file"`));
    assert.equal(done.includes(RETRY_EXHAUSTED_TITLE), false);
    assert.deepEqual(
      page.history.map((h) => [h.jobId, h.status]),
      [[JOB_ID, "ready"]],
    );
    assert.equal(wire.createCalls, 1, "recovery never resubmits the media job");
    assert.equal(wire.maxInFlight, 1);
  });

  it("a manual retry that meets another outage reconnects again with a fresh budget", async () => {
    const { clock, wire, page } = setup([], WORKER_503);
    await page.download();
    await clock.advance(STATUS_POLL_RETRY_BUDGET_MS + 30_000);
    assert.equal(page.state.connectivity, "retry_exhausted");
    page.retryStatus();
    await clock.advance(1_000);
    assertReconnecting(page.render());
    await clock.advance(STATUS_POLL_RETRY_BUDGET_MS + 30_000);
    assert.equal(page.state.connectivity, "retry_exhausted");
    assert.equal(page.state.job?.jobId, JOB_ID);
    assert.equal(wire.maxInFlight, 1);
    assert.equal(wire.createCalls, 1);
  });
});

describe("stale responses cannot resurrect a job", () => {
  it("reset while a status request is in flight", async () => {
    const { clock, wire, page } = setup([{ ...ok(polledJob("ready")), latencyMs: 2_000 }]);
    await page.download();
    await clock.advance(1_000);
    assert.equal(wire.inFlight, 1);
    page.reset();
    await clock.advance(10_000);
    assert.equal(page.state.phase, "idle");
    assert.equal(page.state.job, null);
    assert.equal(page.render(), "");
    assert.equal(page.history.length, 0);
    assert.equal(wire.statusCalls.length, 1);
  });

  it("a new job replaces the old one while the old request is in flight", async () => {
    const { clock, wire, page } = setup(
      [{ ...ok(polledJob("ready")), latencyMs: 5_000 }],
      ok(polledJob("downloading", { jobId: OTHER_JOB_ID, progress: 10 })),
    );
    await page.download();
    await clock.advance(1_000);
    page.reset();
    wire.nextCreatedJobId = OTHER_JOB_ID;
    await page.download();
    await clock.advance(10_000);
    assert.equal(page.state.job?.jobId, OTHER_JOB_ID);
    assert.equal(page.state.phase, "processing");
    assert.equal(page.state.job?.progress, 10);
    assert.equal(page.history.length, 0, "the old job's late ready was not recorded");
    assert.equal(wire.statusCalls[0], JOB_ID);
    assert.ok(wire.statusCalls.length > 2);
    assert.ok(wire.statusCalls.slice(1).every((id) => id === OTHER_JOB_ID), "only the new job is polled");
    assert.equal(wire.maxInFlight, 1);
    assert.equal(page.pollersStarted, 2);
  });

  it("teardown stops every timer and request", async () => {
    const { clock, wire, page } = setup([], WORKER_503);
    await page.download();
    await clock.advance(5_000);
    const calls = wire.statusCalls.length;
    const before = page.state;
    page.unmount();
    await clock.advance(600_000);
    assert.equal(wire.statusCalls.length, calls);
    assert.equal(page.state, before);
  });
});
