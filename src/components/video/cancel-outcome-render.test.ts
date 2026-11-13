import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { errorCardHeading, jobOutcomeRetry, terminalJobMessage } from "@/lib/job-failure-ui";
import type { CancelRequestState } from "@/lib/downloader-state";
import { WorkerJobViewSchema, type WorkerJobView } from "@/shared/worker/contracts";
import { WORKER_RESTART_SAFE_MESSAGE } from "@/shared/worker/job-failure";
import type { JobProgress } from "@/types/job";
import { toPublicJob } from "@/web/jobs/public-job";

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

const { ErrorCard } = await import("./error-card.tsx");
const { CancelDownload, CancelRequestNotice } = await import("./cancel-download.tsx");

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the card each
 * ending renders — Worker view → control-plane projection → wire → card — and
 * the Cancel control's markup in each request state.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000_000;
const HOSTILE =
  "yt-dlp: ERROR <script>x</script> https://media.example/v.mp4?X-Amz-Signature=deadbeef /var/lib/videofetch token=sk-live-S";

function workerJob(overrides: Partial<WorkerJobView>): WorkerJobView {
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "failed",
    progress: 40,
    stageLabel: null,
    downloadedBytes: 400,
    totalBytes: 1_000,
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
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    objectKey: null,
    ...overrides,
  });
}

/** What the browser receives: the projection, through JSON. */
function overTheWire(job: WorkerJobView): JobProgress & { jobId: string } {
  return JSON.parse(JSON.stringify(toPublicJob(job, NOW)));
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();

function card(job: JobProgress, withRetry: boolean): string {
  const retry = withRetry ? jobOutcomeRetry(job) : null;
  return text(
    renderToStaticMarkup(
      createElement(ErrorCard, {
        heading: errorCardHeading(job),
        message: terminalJobMessage(job),
        onReset: () => {},
        retry: retry ? { ...retry, onRetry: () => {} } : null,
      }),
    ),
  );
}

describe("each ending's card", () => {
  const cases: ReadonlyArray<readonly [string, Partial<WorkerJobView>, string]> = [
    ["cancelled", { status: "cancelled", stageLabel: "Cancelled" },
      "Download cancelled This download was cancelled. Try again A new download starts from the beginning. Start over"],
    ["absolute time limit (reserved)", { errorCode: "TIMEOUT", stageLabel: "Download time limit reached", safeErrorMessage: HOSTILE },
      "Time limit reached The download was still running when it reached VideoFetch's maximum download time. Choose another quality A new download starts from the beginning. Start over"],
    ["stall (reserved)", { errorCode: "TIMEOUT", stageLabel: "Download stalled", safeErrorMessage: HOSTILE },
      "Download stalled The source stopped sending data, so VideoFetch stopped waiting. Try again A new download starts from the beginning. Start over"],
    ["download-stage timeout (today's deadline)", { errorCode: "TIMEOUT", stageLabel: "Download failed", safeErrorMessage: HOSTILE },
      "Download failed The download didn't finish in time. Try again A new download starts from the beginning. Start over"],
    ["processing timeout", { errorCode: "TIMEOUT", stageLabel: "Processing failed", safeErrorMessage: HOSTILE },
      "Processing failed Processing took too long. Try again A new download starts from the beginning. Start over"],
    ["upload timeout", { errorCode: "TIMEOUT", stageLabel: "Upload failed", safeErrorMessage: HOSTILE },
      "Upload failed Uploading the finished file took too long. Try again A new download starts from the beginning. Start over"],
    ["Worker restart", { errorCode: "PROCESSING_FAILED", stageLabel: "Worker restarted", safeErrorMessage: WORKER_RESTART_SAFE_MESSAGE },
      "Download interrupted Worker restarted before the job completed. Try again A new download starts from the beginning. Start over"],
    ["source failure", { errorCode: "NETWORK_ERROR", stageLabel: "Download failed", safeErrorMessage: HOSTILE },
      "Download failed We couldn't connect to the source website. Try again A new download starts from the beginning. Start over"],
    ["size limit", { errorCode: "TOO_LARGE", stageLabel: "Download failed", safeErrorMessage: HOSTILE },
      "Download failed This video exceeds the maximum supported download size. Choose another quality A new download starts from the beginning. Start over"],
    ["unclassified", { errorCode: "PROCESSING_FAILED", stageLabel: "Processing failed", safeErrorMessage: HOSTILE },
      "Processing failed VideoFetch couldn't complete this download. Try again A new download starts from the beginning. Start over"],
    ["a reserved stage with the wrong code is not trusted", { errorCode: "NETWORK_ERROR", stageLabel: "Download stalled", safeErrorMessage: HOSTILE },
      "We hit a snag We couldn't connect to the source website. Try again A new download starts from the beginning. Start over"],
    ["a hostile stage label never becomes a heading", { errorCode: "TIMEOUT", stageLabel: HOSTILE, safeErrorMessage: HOSTILE },
      "We hit a snag The download didn't finish in time. Try again A new download starts from the beginning. Start over"],
  ];

  for (const [label, overrides, expected] of cases) {
    it(label, () => {
      const shown = card(overTheWire(workerJob(overrides)), true);
      assert.equal(shown, expected);
      for (const fragment of ["yt-dlp", "<script>", "script", "X-Amz-Signature", "/var/lib", "sk-live", "media.example"]) {
        assert.equal(shown.includes(fragment), false, `${label}: rendered ${fragment}`);
      }
      assert.equal(/took too long to process/.test(shown), false, `${label}: the processing sentence`);
      assert.equal(/resum/i.test(shown), false, `${label}: no resume claim`);
    });
  }

  it("without a job outcome the card keeps Start over only (analysis error, lost job)", () => {
    const html = text(
      renderToStaticMarkup(createElement(ErrorCard, { heading: "We hit a snag", message: "m", onReset: () => {} })),
    );
    assert.equal(html, "We hit a snag m Start over");
  });

  it("a running or finished job never gets a retry action", () => {
    for (const status of ["downloading", "uploading", "ready"] as const) {
      const job = overTheWire(
        workerJob({
          status,
          errorCode: null,
          stageLabel: "Downloading",
          ...(status === "ready"
            ? {
                objectKey: `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111` as WorkerJobView["objectKey"],
                filename: "clip.mp4",
                fileSize: 1,
                mime: "video/mp4",
              }
            : {}),
        }),
      );
      assert.equal(jobOutcomeRetry(job), null, status);
    }
  });
});

describe("the Cancel control's markup", () => {
  const render = (cancel: CancelRequestState, downloadedBytes: number | null = 1_000) =>
    renderToStaticMarkup(createElement(CancelDownload, { downloadedBytes, cancel, onConfirm: () => {} }));

  it("idle: a real button that opens a dialog, nothing pending, no notice", () => {
    const html = render({ kind: "idle" });
    assert.match(html, /<button[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
    assert.match(html, /data-state="closed"/);
    assert.equal(text(html), "Cancel download");
    assert.equal(html.includes("aria-disabled"), false);
    assert.equal(html.includes('role="alert"') || html.includes('role="status"'), false);
    assert.equal(html.includes("Cancel this download?"), false, "the dialog is closed until asked for");
  });

  it("requesting: marked unavailable (keeps focus), says it is cancelling, announces politely", () => {
    const html = render({ kind: "requesting", jobId: JOB_ID, attempt: 1 });
    assert.match(html, /aria-disabled="true"/);
    assert.equal(/<button[^>]*\sdisabled[\s>=]/.test(html), false, "not the disabled attribute: focus can stay");
    assert.match(html, /role="status"[^>]*aria-live="polite"[^>]*>Cancelling the download…</);
    assert.ok(text(html).startsWith("Cancelling…"));
  });

  it("unconfirmed: an alert that says it may still be running; the button is usable again", () => {
    const html = render({ kind: "unconfirmed", jobId: JOB_ID, attempt: 1 });
    assert.match(html, /role="alert"/);
    assert.ok(text(html).includes("We couldn't confirm the cancellation. The download may still be running."));
    assert.equal(html.includes("aria-disabled"), false);
  });

  it("refused: an alert with the canonical reason", () => {
    const html = render({ kind: "refused", jobId: JOB_ID, attempt: 1, message: "Too many requests. Please wait a moment and try again." });
    assert.match(html, /role="alert"/);
    assert.ok(text(html).includes("The download wasn't cancelled. Too many requests."));
  });

  it("the notice renders nothing when idle", () => {
    assert.equal(renderToStaticMarkup(createElement(CancelRequestNotice, { cancel: { kind: "idle" } })), "");
  });
});
