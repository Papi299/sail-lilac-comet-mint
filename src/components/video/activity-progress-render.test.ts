import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ACTIVITY_LABELS, STAGE_DESCRIPTIONS, WAITING_NOTICE_MESSAGE, WAITING_NOTICE_TITLE } from "@/lib/job-activity-ui";
import { polledJob } from "@/lib/job-status-poll.fixtures";
import type { JobActivity } from "@/types/job";

// Node strips types from .ts but cannot load .tsx; see source-quality-render.test.ts.
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
const { RestoringCard, RESTORING_TITLE } = await import("./restoring-card.tsx");
const { JobSummary } = await import("./job-summary.tsx");

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the rendered
 * markup of the new progress details, for what assistive technology and a
 * narrow screen depend on. (The real-browser checks — focus, reload, layout at
 * 390 px — are in the review kit.)
 */

const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

const now = Date.now();
const running = (activity: JobActivity | null, overrides: Parameters<typeof polledJob>[1] = {}) =>
  polledJob("downloading", { activity, createdAt: now - 95_000, expiresAt: now + 5_000_000, eta: null, ...overrides });

const render = (job: ReturnType<typeof running>, connectivity: "connected" | "reconnecting" = "connected") =>
  decode(renderToStaticMarkup(createElement(ProgressCard, { job, connectivity })));

/** The live regions in the markup, in order: [attributes, text]. */
function liveRegions(html: string): Array<{ tag: string; text: string }> {
  const regions: Array<{ tag: string; text: string }> = [];
  const pattern = /<(p|div)([^>]*role="status"[^>]*)>(.*?)<\/\1>/g;
  for (const match of html.matchAll(pattern)) regions.push({ tag: match[2], text: match[3].replace(/<[^>]+>/g, "") });
  return regions;
}

describe("the progress card's announcements", () => {
  it("announces the stage politely; the activity line and the clock are not live regions", () => {
    const html = render(running({ state: "receiving", elapsedSeconds: 42, limitSeconds: 600, idleSeconds: 0 }));
    const regions = liveRegions(html);
    assert.equal(regions.length, 1, "only the stage");
    assert.match(regions[0].tag, /aria-live="polite"/);
    assert.match(regions[0].tag, /aria-atomic="true"/);
    assert.equal(regions[0].text, STAGE_DESCRIPTIONS.downloading);
    assert.ok(html.includes(ACTIVITY_LABELS.receiving), "the activity is visible");
    assert.ok(html.includes("Elapsed since request") && html.includes("1:35"));
    assert.ok(html.includes("Download time limit") && html.includes("10 min"));
    assert.ok(html.includes("Downloading for") && html.includes("0:42"));
    assert.equal(/remaining|time left before/i.test(html), false, "no countdown to the limit");
  });

  it("the waiting notice is a polite status, worded without alarm, and announced once it appears", () => {
    const html = render(running({ state: "waiting", elapsedSeconds: 80, limitSeconds: 600, idleSeconds: 21 }));
    const regions = liveRegions(html);
    assert.equal(regions.length, 2);
    assert.match(regions[1].tag, /aria-live="polite"/);
    assert.ok(regions[1].text.includes(WAITING_NOTICE_TITLE) && regions[1].text.includes(WAITING_NOTICE_MESSAGE));
    assert.equal(/stall|fail|error/i.test(regions[1].text), false);
  });

  it("each activity is told apart by its words and its icon, never by colour alone", () => {
    for (const state of ["awaiting-first-byte", "receiving", "waiting", "between-resources", "between-phases", "unobserved", "starting"] as const) {
      const idle = state === "between-phases" || state === "unobserved" || state === "starting" ? null : state === "receiving" ? 1 : 6;
      const html = render(running({ state, elapsedSeconds: 30, limitSeconds: 600, idleSeconds: idle }));
      assert.ok(html.includes(ACTIVITY_LABELS[state]), state);
      assert.ok(html.includes(`data-activity-state="${state}"`), state);
      assert.match(html, /<svg[^>]*aria-hidden="true"/, `${state}: the icon is decorative`);
    }
  });

  it("the progress bar is labelled; the spinner respects reduced motion", () => {
    const html = render(running(null, { progress: 40 }));
    assert.match(html, /role="progressbar"[^>]*aria-label="Download progress"|aria-label="Download progress"[^>]*role="progressbar"/);
    assert.ok(html.includes("motion-safe:animate-spin"));
    assert.equal(/ animate-spin/.test(html.replaceAll("motion-safe:animate-spin", "")), false);
  });

  it("an ETA is an estimate, never a promise", () => {
    const html = render(running(null, { eta: 300 }));
    assert.ok(html.includes("Estimated about 5 min left"));
  });

  it("during an outage the activity is not shown as current", () => {
    const html = render(running({ state: "waiting", elapsedSeconds: 80, limitSeconds: 600, idleSeconds: 40 }), "reconnecting");
    assert.equal(html.includes(ACTIVITY_LABELS.waiting), false);
    assert.equal(html.includes(WAITING_NOTICE_TITLE), false);
    assert.ok(html.includes("10 min"), "the limit is still a fact");
  });

  it("an older Worker's status (no activity) renders the card exactly as before, plus the elapsed time", () => {
    const html = render(running(null, { activity: undefined }));
    for (const label of Object.values(ACTIVITY_LABELS)) assert.equal(html.includes(label), false);
    assert.equal(html.includes("Download time limit"), false);
    assert.ok(html.includes("Elapsed since request"));
  });
});

describe("the restoring card and the job summary", () => {
  it("restoring is a polite status that says nothing new is started", () => {
    const html = decode(
      renderToStaticMarkup(createElement(RestoringCard, { connectivity: "connected", onRetryStatus: () => {}, onReset: () => {} })),
    );
    const regions = liveRegions(html);
    assert.equal(regions.length, 1);
    assert.ok(regions[0].text.includes(RESTORING_TITLE));
    assert.ok(regions[0].text.includes("Nothing new is started"));
  });

  it("the job summary wraps long titles and truncates a long source instead of overflowing", () => {
    const html = decode(
      renderToStaticMarkup(
        createElement(JobSummary, {
          job: { title: "x".repeat(300), thumbnail: null, source: "y".repeat(200), quality: "1080", container: "mp4" },
        }),
      ),
    );
    assert.match(html, /<h2 class="[^"]*break-words/);
    assert.match(html, /class="truncate"/);
    assert.ok(html.includes("1080 · MP4"));
  });
});
