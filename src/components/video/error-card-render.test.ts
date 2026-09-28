import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ERROR_MESSAGES } from "@/lib/errors";
import {
  DEFAULT_ERROR_HEADING,
  errorCardHeading,
  terminalJobMessage,
} from "@/lib/job-failure-ui";
import { WorkerJobViewSchema, type WorkerJobView } from "@/shared/worker/contracts";
import { WORKER_RESTART_SAFE_MESSAGE } from "@/shared/worker/job-failure";
import type { JobProgress } from "@/types/job";
import { toPublicJob } from "@/web/jobs/public-job";

// Node strips types from .ts but cannot load .tsx; see
// source-quality-render.test.ts. The JSX is transpiled in-thread, only for the
// component imported below.
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

const { ErrorCard } = await import("./error-card.tsx");

/**
 * MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: what a person actually sees.
 *
 * Every case starts from a Worker job view, crosses the control plane's own
 * `toPublicJob` and a JSON round trip (the wire), then goes through the exact
 * helpers the route uses to fill the error card.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000_000;

const HOSTILE =
  "ffmpeg: /var/lib/videofetch/jobs/x/source.mp4: moov atom not found " +
  "https://media.example/v.mp4?X-Amz-Signature=deadbeef token=sk-live-SECRET at run (worker.ts:9:9)";

function workerJob(overrides: Partial<WorkerJobView>): WorkerJobView {
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "failed",
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
    title: "Clip",
    thumbnail: null,
    source: "cdn.example",
    extractor: "direct",
    createdAt: NOW - 1000,
    updatedAt: NOW - 500,
    expiresAt: NOW + 60_000,
    objectKey: null,
    ...overrides,
  });
}

/** Worker view → control plane → wire → the browser's JobProgress. */
function overTheWire(view: WorkerJobView): JobProgress {
  return JSON.parse(JSON.stringify(toPublicJob(view, NOW))) as JobProgress;
}

/** Visible text only: tags stripped, the entities that matter here decoded. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Renders the card exactly as the route does for a terminal job. */
function card(job: JobProgress | null, message: string): string {
  return text(
    renderToStaticMarkup(
      createElement(ErrorCard, { heading: errorCardHeading(job), message, onReset: () => {} }),
    ),
  );
}

function terminalCard(view: WorkerJobView): string {
  const job = overTheWire(view);
  return card(job, terminalJobMessage(job));
}

describe("the error card for representative failures", () => {
  const cases: ReadonlyArray<readonly [string, Partial<WorkerJobView>, string]> = [
    [
      "a source that dropped the connection",
      { errorCode: "NETWORK_ERROR", safeErrorMessage: HOSTILE, stageLabel: "Download failed" },
      "Download failed We couldn't connect to the source website. Start over",
    ],
    [
      "a download past its deadline",
      { errorCode: "TIMEOUT", safeErrorMessage: HOSTILE, stageLabel: "Download failed" },
      "Download failed The video took too long to process. Start over",
    ],
    [
      "a video over the size limit",
      { errorCode: "TOO_LARGE", safeErrorMessage: HOSTILE, stageLabel: "Download failed" },
      "Download failed This video exceeds the maximum supported download size. Start over",
    ],
    [
      "a quality that is no longer offered",
      { errorCode: "FORMAT_UNAVAILABLE", safeErrorMessage: HOSTILE, stageLabel: "Download failed" },
      "Download failed The selected quality is no longer available. Start over",
    ],
    [
      "a page whose streams could not be extracted",
      { errorCode: "EXTRACTION_FAILED", safeErrorMessage: HOSTILE, stageLabel: "Download failed" },
      "Download failed We couldn't extract the video streams from this page. Start over",
    ],
    [
      "a removed or private video",
      { errorCode: "VIDEO_UNAVAILABLE", safeErrorMessage: HOSTILE, stageLabel: "Download failed" },
      "Download failed The video could not be accessed or is no longer available. Start over",
    ],
    [
      "a local merge or conversion failure",
      { errorCode: "PROCESSING_FAILED", safeErrorMessage: HOSTILE, stageLabel: "Processing failed" },
      "Processing failed VideoFetch couldn't complete this download. Start over",
    ],
    [
      "an object-store failure",
      { errorCode: "PROCESSING_FAILED", safeErrorMessage: HOSTILE, stageLabel: "Upload failed" },
      "Upload failed VideoFetch couldn't complete this download. Start over",
    ],
    [
      "a Worker restart",
      {
        errorCode: "PROCESSING_FAILED",
        safeErrorMessage: WORKER_RESTART_SAFE_MESSAGE,
        stageLabel: "Worker restarted",
      },
      "Download interrupted Worker restarted before the job completed. Start over",
    ],
    [
      "a row an older Worker failed (last progress label, old copy)",
      {
        errorCode: "PROCESSING_FAILED",
        safeErrorMessage: "We couldn't process this video. Try another format or source.",
        stageLabel: "downloading",
      },
      "We hit a snag VideoFetch couldn't complete this download. Start over",
    ],
    [
      "a failure with a hostile stage label",
      { errorCode: "NETWORK_ERROR", safeErrorMessage: HOSTILE, stageLabel: HOSTILE },
      "We hit a snag We couldn't connect to the source website. Start over",
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    it(label, () => {
      const shown = terminalCard(workerJob(overrides));
      assert.equal(shown, expected);
      for (const fragment of ["/var/lib", "moov atom", "X-Amz-Signature", "sk-live", "worker.ts", "media.example"]) {
        assert.equal(shown.includes(fragment), false, `${label}: rendered ${fragment}`);
      }
      assert.equal(/another format or source/i.test(shown), false, `${label}: unfounded advice`);
    });
  }

  it("a cancelled job keeps its own message and the generic heading", () => {
    assert.equal(
      terminalCard(workerJob({ status: "cancelled" })),
      "We hit a snag This download was cancelled. Start over",
    );
  });
});

describe("the error card heading", () => {
  it("is generic when there is no job (an analysis error)", () => {
    assert.equal(errorCardHeading(null), DEFAULT_ERROR_HEADING);
  });

  it("is generic for a job that has not failed (a failed status poll)", () => {
    for (const status of ["downloading", "processing", "uploading", "cancelled"] as const) {
      const job = overTheWire(workerJob({ status, stageLabel: "Upload failed" }));
      assert.equal(errorCardHeading(job), DEFAULT_ERROR_HEADING, status);
    }
  });

  it("falls back to the canonical message when a failed job carries none", () => {
    const job = { status: "failed", error: null } as const;
    assert.equal(terminalJobMessage(job), ERROR_MESSAGES.PROCESSING_FAILED);
  });
});
