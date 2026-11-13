import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { cancelDownload, getJobStatus, startDownload, type PolledJob } from "@/lib/client-api";
import { createCancelController, type CancelController } from "@/lib/download-cancel";
import {
  downloaderReducer,
  finishedJobForHistory,
  initialDownloaderState,
  startStatusPollSession,
  statusPollTarget,
  type DownloaderAction,
  type DownloaderState,
  type StatusPollSession,
} from "@/lib/downloader-state";
import { ERROR_MESSAGES } from "@/lib/errors";
import { DEFAULT_ERROR_HEADING, errorCardHeading, jobOutcomeRetry } from "@/lib/job-failure-ui";
import { STATUS_POLL_RETRY_BUDGET_MS, type JobStatusPoller } from "@/lib/job-status-poller";
import { FakeClock, JOB_ID, OTHER_JOB_ID, polledJob } from "@/lib/job-status-poll.fixtures";
import { WORKER_RESTART_SAFE_MESSAGE } from "@/shared/worker/job-failure";

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
const { StatusConnectionNotice, RETRY_EXHAUSTED_TITLE } = await import("./status-connection-notice.tsx");
const {
  CancelDownload,
  CANCEL_BUTTON_LABEL,
  CANCELLING_LABEL,
  CANCELLING_STATUS,
  CANCEL_UNCONFIRMED_TITLE,
  CANCEL_REFUSED_TITLE,
} = await import("./cancel-download.tsx");

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the downloader with
 * cancellation, end to end minus the DOM. `fetch` is mocked with real wire
 * responses; the REAL client calls, poll loop, reducer, cancel controller and
 * cards do the rest, on a fake clock. `Page` mirrors the route: it runs the
 * polling effect the same way and renders the job region with the route's own
 * conditions and components.
 */

type WireStep = { latencyMs?: number } & (
  | { status: number; body: unknown }
  | { html: string; status: number }
  | { reject: true }
  | { hang: true }
);

const ok = (job: PolledJob): WireStep => ({ status: 200, body: job });
const failure = (code: keyof typeof ERROR_MESSAGES, status: number): WireStep => ({
  status,
  body: { success: false, error: { code, message: ERROR_MESSAGES[code] } },
});
const NETWORK_DROP: WireStep = { reject: true };
const HANG: WireStep = { hang: true };

type Seen = { url: string; init: RequestInit | undefined };

class Wire {
  status: string[] = [];
  cancels: Seen[] = [];
  creates = 0;
  unscripted = 0;
  private readonly statusSteps: WireStep[] = [];
  private readonly cancelSteps: WireStep[] = [];
  nextJobId = JOB_ID;
  private readonly clock: FakeClock;
  private readonly statusFallback: WireStep | null;
  constructor(clock: FakeClock, statusFallback: WireStep | null = null) {
    this.clock = clock;
    this.statusFallback = statusFallback;
  }

  pushStatus(...steps: WireStep[]) {
    this.statusSteps.push(...steps);
  }
  pushCancel(...steps: WireStep[]) {
    this.cancelSteps.push(...steps);
  }

  readonly fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST" && input === "/api/download") {
      this.creates += 1;
      return Response.json(polledJob("queued", { jobId: this.nextJobId, progress: null, stageLabel: "Queued" }));
    }
    const cancelMatch = /^\/api\/download\/([0-9a-f]{32})\/cancel$/.exec(input);
    if (cancelMatch) {
      this.cancels.push({ url: input, init });
      return this.answer(this.cancelSteps.shift() ?? null, init);
    }
    const statusMatch = /^\/api\/download\/([0-9a-f]{32})\/status$/.exec(input);
    assert.ok(statusMatch, `unexpected request ${input}`);
    this.status.push(statusMatch[1]);
    return this.answer(this.statusSteps.shift() ?? this.statusFallback, init);
  }) as typeof fetch;

  private answer(step: WireStep | null, init: RequestInit | undefined): Promise<Response> {
    if (!step) {
      this.unscripted += 1;
      return Promise.reject(new TypeError("unscripted request"));
    }
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const end = (fn: () => void) => {
        if (!done) {
          done = true;
          fn();
        }
      };
      init?.signal?.addEventListener("abort", () =>
        end(() => reject(new DOMException("The operation was aborted.", "AbortError"))),
      );
      if ("hang" in step) return;
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
  }
}

class Page {
  state: DownloaderState = initialDownloaderState;
  history: PolledJob[] = [];
  private poller: JobStatusPoller | null = null;
  private pollKey: { jobId: string; session: StatusPollSession } | null = null;
  private lastFinished: PolledJob | null = null;
  private mounted = true;
  readonly cancelController: CancelController;
  hasVideo = false;
  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
    this.cancelController = createCancelController({
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

  private runEffects() {
    if (!this.mounted) return;
    const target = statusPollTarget(this.state);
    if (target?.jobId !== this.pollKey?.jobId || target?.session !== this.pollKey?.session) {
      this.poller?.stop();
      this.poller = null;
      this.pollKey = target;
      if (target) {
        this.poller = startStatusPollSession(target, this.dispatch, (id, signal) => getJobStatus(id, { signal }), this.clock);
      }
    }
    const finished = finishedJobForHistory(this.state);
    if (finished && finished !== this.lastFinished) this.history.push(finished);
    this.lastFinished = finished;
  }

  async download() {
    this.hasVideo = true;
    this.dispatch({ type: "analyze_started" });
    this.dispatch({ type: "analyze_succeeded" });
    this.dispatch({ type: "download_requested" });
    const created = await startDownload({ url: "https://cdn.example/clip.mp4", formatId: "direct-original" });
    this.dispatch({ type: "download_started", job: created });
    await this.clock.advance(0);
  }

  /** The dialog's confirm action, as the route wires it. */
  confirmCancel(): boolean {
    return this.state.job ? this.cancelController.request(this.state.job.jobId) : false;
  }

  /** The error card's "Try again" / "Choose another quality". */
  chooseAgain() {
    this.dispatch({ type: "choose_again" });
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
    this.cancelController.dispose();
    this.mounted = false;
  }

  render(): string {
    const { phase, job, error, connectivity, cancel } = this.state;
    const noop = () => {};
    const parts: ReactElement[] = [];
    if (phase === "error" && error) {
      const retry = this.hasVideo ? jobOutcomeRetry(job) : null;
      parts.push(
        createElement(ErrorCard, {
          key: "e",
          heading: errorCardHeading(job),
          message: error,
          onReset: noop,
          retry: retry ? { ...retry, onRetry: noop } : null,
        }),
      );
    }
    if (phase === "processing" && job) {
      parts.push(createElement(ProgressCard, { key: "p", job }));
      parts.push(createElement(CancelDownload, { key: "c", downloadedBytes: job.downloadedBytes, cancel, onConfirm: noop }));
      parts.push(createElement(StatusConnectionNotice, { key: "n", connectivity, onRetryStatus: noop, onReset: noop }));
    }
    if (phase === "complete" && job) parts.push(createElement(CompleteCard, { key: "k", job, onReset: noop }));
    if (phase === "ready" && this.hasVideo) parts.push(createElement("p", { key: "f" }, "QUALITY-PICKER"));
    return decode(renderToStaticMarkup(createElement(Fragment, null, ...parts)));
  }
}

const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setup(statusFallback: WireStep | null = null) {
  const clock = new FakeClock();
  const wire = new Wire(clock, statusFallback);
  globalThis.fetch = wire.fetch;
  const page = new Page(clock);
  return { clock, wire, page };
}

const downloading = (overrides: Partial<PolledJob> = {}) =>
  polledJob("downloading", { progress: 42, stageLabel: "Downloading", ...overrides });
const cancelledJob = (jobId = JOB_ID) => polledJob("cancelled", { jobId, stageLabel: "Cancelled" });

describe("the cancel request on the wire", () => {
  it("is one same-origin POST with keepalive and no body, to this job's cancel route", async () => {
    const { wire, page, clock } = setup();
    wire.pushStatus(ok(downloading()));
    wire.pushCancel(ok(cancelledJob()));
    await page.download();
    await clock.advance(800);
    assert.equal(page.confirmCancel(), true);
    await clock.advance(0);
    assert.equal(wire.cancels.length, 1);
    const [{ url, init }] = wire.cancels;
    assert.equal(url, `/api/download/${JOB_ID}/cancel`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.keepalive, true);
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
  });
});

describe("cancelling a running download", () => {
  it("queued: the job is shown cancelled, polling stops, history records it, one POST", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(ok(cancelledJob()));
    await page.download();
    let html = page.render();
    assert.ok(html.includes(CANCEL_BUTTON_LABEL), "the Cancel action is offered while the job runs");
    assert.ok(html.includes('aria-haspopup="dialog"'), "it opens a dialog");
    page.confirmCancel();
    html = page.render();
    assert.ok(html.includes(CANCELLING_LABEL) && html.includes(CANCELLING_STATUS), "pending state is visible");
    assert.ok(html.includes('aria-disabled="true"'));
    assert.equal(html.includes("Download cancelled"), false, "not shown as cancelled before the answer");
    await clock.advance(0);
    html = page.render();
    assert.ok(html.includes("Download cancelled") && html.includes("This download was cancelled."));
    assert.ok(html.includes("Try again") && html.includes("A new download starts from the beginning."));
    assert.equal(page.history.length, 1);
    assert.equal(page.history[0].status, "cancelled");
    const statusReads = wire.status.length;
    await clock.advance(600_000);
    assert.equal(wire.status.length, statusReads, "polling stopped");
    assert.equal(wire.cancels.length, 1);
    assert.equal(wire.unscripted, 0);
  });

  it("while downloading, the progress stays until the Worker's answer", async () => {
    const { wire, page, clock } = setup();
    wire.pushStatus(ok(downloading({ progress: 61 })));
    wire.pushCancel({ ...ok(cancelledJob()), latencyMs: 2_000 });
    await page.download();
    await clock.advance(800);
    page.confirmCancel();
    wire.pushStatus(ok(downloading({ progress: 63 })));
    await clock.advance(800);
    const html = page.render();
    assert.ok(html.includes("63%"), "progress keeps updating while the request is out");
    assert.ok(html.includes(CANCELLING_STATUS));
    await clock.advance(1_200);
    assert.ok(page.render().includes("Download cancelled"));
  });

  it("a double click sends one request", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(ok(cancelledJob()));
    await page.download();
    assert.equal(page.confirmCancel(), true);
    assert.equal(page.confirmCancel(), false);
    await clock.advance(0);
    assert.equal(page.confirmCancel(), false, "nothing left to cancel");
    assert.equal(wire.cancels.length, 1);
  });
});

describe("the Worker decides the outcome", () => {
  it("the job had already become ready: the finished download is shown, not a cancellation", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(ok(polledJob("ready")));
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    const html = page.render();
    assert.ok(html.includes("Your video is ready"));
    assert.ok(html.includes(`href="/api/download/${JOB_ID}/file"`));
    assert.equal(html.includes("Download cancelled"), false);
    assert.equal(page.history[0].status, "ready");
  });

  it("the job had already failed: its failure is shown, with its own heading and message", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(
      ok(polledJob("failed", { errorCode: "TIMEOUT", stageLabel: "Download failed", error: "The download didn't finish in time." })),
    );
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    const html = page.render();
    assert.ok(html.includes("Download failed") && html.includes("The download didn't finish in time."));
    assert.equal(html.includes("took too long to process"), false);
    assert.equal(html.includes("Download cancelled"), false);
  });

  it("a poll reporting ready lands first: the late cancel answer is dropped (ready beats cancel)", async () => {
    const { wire, page, clock } = setup();
    wire.pushStatus(ok(polledJob("ready")));
    wire.pushCancel({ ...ok(cancelledJob()), latencyMs: 1_500 });
    await page.download();
    page.confirmCancel();
    await clock.advance(800);
    assert.equal(page.state.phase, "complete");
    await clock.advance(1_000);
    assert.equal(page.state.phase, "complete", "a late (even forged) cancelled answer cannot overwrite ready");
    assert.ok(page.render().includes("Your video is ready"));
  });

  it("a poll reporting cancelled lands first: the outcome is shown once", async () => {
    const { wire, page, clock } = setup();
    wire.pushStatus(ok(cancelledJob()));
    wire.pushCancel({ ...ok(cancelledJob()), latencyMs: 1_500 });
    await page.download();
    page.confirmCancel();
    await clock.advance(5_000);
    assert.equal(page.history.length, 1);
    assert.ok(page.render().includes("Download cancelled"));
  });
});

describe("when the answer is lost", () => {
  it("network drop: not announced as cancelled, never resent, and the status read settles it", async () => {
    const { wire, page, clock } = setup();
    wire.pushStatus(ok(downloading()));
    wire.pushCancel(NETWORK_DROP);
    await page.download();
    await clock.advance(800);
    page.confirmCancel();
    await clock.advance(0);
    let html = page.render();
    assert.ok(html.includes(CANCEL_UNCONFIRMED_TITLE));
    assert.ok(html.includes("may still be running"));
    assert.equal(html.includes("Download cancelled"), false);
    assert.ok(html.includes(CANCEL_BUTTON_LABEL), "the person may cancel again");
    // The cancellation had in fact reached the Worker: the next status read says so.
    wire.pushStatus(ok(cancelledJob()));
    await clock.advance(800);
    html = page.render();
    assert.ok(html.includes("Download cancelled"));
    assert.equal(wire.cancels.length, 1, "never resent automatically");
  });

  it("a cancel request that never answers is given up at the browser timeout, still unconfirmed", async () => {
    const { wire, page, clock } = setup(ok(downloading()));
    wire.pushCancel(HANG);
    await page.download();
    page.confirmCancel();
    await clock.advance(44_999);
    assert.equal(page.state.cancel.kind, "requesting");
    await clock.advance(1);
    assert.equal(page.state.cancel.kind, "unconfirmed");
    assert.equal(wire.cancels[0].init?.signal?.aborted, true);
    assert.equal(page.state.phase, "processing");
    assert.equal(wire.cancels.length, 1);
  });

  for (const [label, step] of [
    ["503 WORKER_UNAVAILABLE", failure("WORKER_UNAVAILABLE", 503)],
    ["500 PROCESSING_FAILED", failure("PROCESSING_FAILED", 500)],
    ["a 502 edge page with no envelope", { html: "<html>502 Bad Gateway</html>", status: 502 } as WireStep],
    ["a 200 that is not this job's status", { status: 200, body: { hello: "interstitial" } } as WireStep],
    ["a 200 naming another job", ok(cancelledJob(OTHER_JOB_ID))],
  ] as const) {
    it(`${label} is unconfirmed, never a job failure`, async () => {
      const { wire, page, clock } = setup(ok(downloading()));
      wire.pushCancel(step);
      await page.download();
      page.confirmCancel();
      await clock.advance(0);
      assert.equal(page.state.phase, "processing");
      assert.equal(page.state.job?.jobId, JOB_ID);
      assert.equal(page.state.cancel.kind, "unconfirmed");
      assert.equal(page.history.length, 0);
      const html = page.render();
      assert.equal(html.includes(DEFAULT_ERROR_HEADING), false);
      assert.equal(html.includes("Bad Gateway") || html.includes("interstitial"), false);
    });
  }

  it("while the status channel had given up: a failed cancel starts one reconnecting read, which settles it", async () => {
    const { wire, page, clock } = setup(failure("WORKER_UNAVAILABLE", 503));
    await page.download();
    await clock.advance(STATUS_POLL_RETRY_BUDGET_MS + 20_000);
    assert.equal(page.state.connectivity, "retry_exhausted");
    assert.ok(page.render().includes(RETRY_EXHAUSTED_TITLE));
    const readsBefore = wire.status.length;
    wire.pushCancel(failure("WORKER_UNAVAILABLE", 503));
    page.confirmCancel();
    wire.pushStatus(ok(cancelledJob()));
    await clock.advance(0);
    await clock.advance(0);
    assert.ok(wire.status.length > readsBefore, "the job's status is read again");
    assert.ok(page.render().includes("Download cancelled"));
    assert.equal(wire.cancels.length, 1);
  });
});

describe("refusals, sessions, restarts and stale answers", () => {
  it("rate limited: the reason is shown, the job keeps running, polling continues", async () => {
    const { wire, page, clock } = setup(ok(downloading()));
    wire.pushCancel(failure("RATE_LIMITED", 429));
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    const html = page.render();
    assert.ok(html.includes(CANCEL_REFUSED_TITLE) && html.includes(ERROR_MESSAGES.RATE_LIMITED));
    assert.ok(statusPollTarget(page.state));
  });

  it("an older control plane without the route (404, no envelope): 'not available', nothing else changes", async () => {
    const { wire, page, clock } = setup(ok(downloading()));
    wire.pushCancel({ html: "<html>Not Found</html>", status: 404 });
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    const html = page.render();
    assert.ok(html.includes("Cancelling isn't available right now."));
    assert.equal(page.state.phase, "processing");
  });

  it("logged out meanwhile: the cancel is refused, then the status channel ends the page with the access message", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(failure("ACCESS_REQUIRED", 401));
    wire.pushStatus(failure("ACCESS_REQUIRED", 401));
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    assert.ok(page.render().includes(ERROR_MESSAGES.ACCESS_REQUIRED));
    await clock.advance(800);
    assert.equal(page.state.phase, "error");
    const html = page.render();
    assert.ok(html.includes(ERROR_MESSAGES.ACCESS_REQUIRED));
    assert.equal(html.includes("Try again"), false, "an access failure is not a job outcome");
    assert.equal(page.history.length, 0);
  });

  it("the Worker restarts during the cancellation: unconfirmed, then the restart outcome with Try again", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(failure("WORKER_UNAVAILABLE", 503));
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    wire.pushStatus(
      ok(polledJob("failed", { errorCode: "PROCESSING_FAILED", stageLabel: "Worker restarted", error: WORKER_RESTART_SAFE_MESSAGE })),
    );
    await clock.advance(800);
    const html = page.render();
    assert.ok(html.includes("Download interrupted") && html.includes(WORKER_RESTART_SAFE_MESSAGE));
    assert.ok(html.includes("Try again"));
  });

  it("an older job's late answer after a new job started changes nothing", async () => {
    const { wire, page, clock } = setup(ok(downloading()));
    wire.pushCancel({ ...ok(cancelledJob(JOB_ID)), latencyMs: 5_000 });
    await page.download();
    page.confirmCancel();
    page.reset();
    wire.nextJobId = OTHER_JOB_ID;
    await page.download();
    await clock.advance(5_000);
    assert.equal(page.state.phase, "processing");
    assert.equal(page.state.job?.jobId, OTHER_JOB_ID);
    assert.equal(page.render().includes("Download cancelled"), false);
  });

  it("unmounted while the request is out: nothing is applied, and the request is not aborted", async () => {
    const { wire, page, clock } = setup(ok(downloading()));
    wire.pushCancel({ ...ok(cancelledJob()), latencyMs: 3_000 });
    await page.download();
    page.confirmCancel();
    const before = page.state;
    page.unmount();
    await clock.advance(60_000);
    assert.equal(page.state, before);
    assert.equal(wire.cancels[0].init?.signal?.aborted, false);
  });
});

describe("after the ending: try again and retry status are different operations", () => {
  it("Try again returns to the quality choice; only Download creates a new job, from the beginning", async () => {
    const { wire, page, clock } = setup();
    wire.pushCancel(ok(cancelledJob()));
    await page.download();
    page.confirmCancel();
    await clock.advance(0);
    const createsBefore = wire.creates;
    const cancelsBefore = wire.cancels.length;
    const statusBefore = wire.status.length;
    page.chooseAgain();
    await clock.advance(10_000);
    assert.equal(page.state.phase, "ready");
    assert.ok(page.render().includes("QUALITY-PICKER"));
    assert.equal(wire.creates, createsBefore, "nothing is sent by Try again itself");
    assert.equal(wire.cancels.length, cancelsBefore);
    assert.equal(wire.status.length, statusBefore, "the old job is not polled or resumed");
    wire.nextJobId = OTHER_JOB_ID;
    await page.download();
    assert.equal(wire.creates, createsBefore + 1, "one new job");
    assert.equal(page.state.job?.jobId, OTHER_JOB_ID, "a NEW job, not the cancelled one resumed");
  });

  it("Retry status only reads the same job's status: no new job and no cancellation", async () => {
    const { wire, page, clock } = setup(failure("WORKER_UNAVAILABLE", 503));
    await page.download();
    await clock.advance(STATUS_POLL_RETRY_BUDGET_MS + 20_000);
    assert.equal(page.state.connectivity, "retry_exhausted");
    const creates = wire.creates;
    wire.pushStatus(ok(downloading({ progress: 80 })));
    page.retryStatus();
    await clock.advance(0);
    assert.equal(wire.creates, creates);
    assert.equal(wire.cancels.length, 0);
    assert.equal(page.state.job?.jobId, JOB_ID);
    assert.equal(page.state.connectivity, "connected");
  });
});
