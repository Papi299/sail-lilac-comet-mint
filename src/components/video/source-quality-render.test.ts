import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  direct,
  gap2160,
  generic,
  noCompatible,
  protectedUnenumerated,
  quality,
  unknownResolution,
  xCase,
  xCasePresets,
} from "@/lib/source-quality-ui.fixtures";
import type { VideoMetadata } from "@/types/media";

// Node strips types from .ts but cannot load .tsx. The shared alias loader is
// also the Worker image's runtime loader, so it stays untouched: this file
// transpiles JSX itself, in-thread, with the project's own TypeScript, and only
// for the components it imports below.
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

const { FormatSelector } = await import("./format-selector.tsx");
const { NoCompatibleDownload } = await import("./no-compatible-download.tsx");

const noop = () => {};

function selector(video: VideoMetadata, simpleMode = true): string {
  return renderToStaticMarkup(
    createElement(FormatSelector, {
      video,
      simpleMode,
      onSimpleMode: noop,
      selectedId: "preset:best",
      onSelect: noop,
      onDownload: noop,
    }),
  );
}

function unavailable(video: VideoMetadata): string {
  return renderToStaticMarkup(
    createElement(NoCompatibleDownload, { sourceQuality: video.sourceQuality, onTryAnother: noop }),
  );
}

/** Visible text only: tags stripped, entities that matter here decoded. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function advancedSwitch(markup: string): string {
  const match = markup.match(/<button[^>]*role="switch"[^>]*>/);
  assert.ok(match, "the Advanced switch renders");
  return match[0];
}

function downloadButton(markup: string): string {
  const match = markup.match(/<button(?:(?!<button).)*?>Download<\/button>/);
  assert.ok(match, "the Download button renders");
  return match[0];
}

describe("rendered: 2160 observed, 720 downloadable", () => {
  const markup = selector(gap2160());
  const visible = text(markup);

  it("shows the informational gap notice with both facts and the reason", () => {
    assert.match(markup, /role="note"/);
    assert.ok(visible.includes("Higher source quality detected"));
    assert.ok(visible.includes("Highest observed: 2160p"));
    assert.ok(visible.includes("Best downloadable: 720p"));
    assert.ok(
      visible.includes("Higher-quality streams use a stream type VideoFetch does not support yet."),
    );
    assert.equal(visible.includes("unsupported_protocol"), false);
  });

  it("offers no 2160 value anywhere a selection could come from", () => {
    assert.equal(/value="[^"]*2160/.test(markup), false);
  });
});

describe("rendered: the live X/Twitter equal-quality case", () => {
  const markup = selector(xCase());
  const visible = text(markup);

  it("shows no higher-quality notice and no 384", () => {
    assert.equal(visible.includes("Higher source quality detected"), false);
    assert.equal(/role="note"/.test(markup), false);
    assert.equal(visible.includes("384"), false);
  });

  it("disables Advanced, says so without hovering, and keeps Download enabled", () => {
    assert.match(advancedSwitch(markup), /\sdisabled=""/);
    assert.match(advancedSwitch(markup), /aria-checked="false"/);
    assert.ok(visible.includes("Advanced unavailable for this source"));
    assert.equal(/\sdisabled=""/.test(downloadButton(markup)), false);
  });

  it("renders the simple selector even when the switch was last left on Advanced", () => {
    const stale = text(selector(xCase(), false));
    assert.ok(stale.includes("Quality"));
    assert.equal(stale.includes("Source format"), false);
  });
});

describe("rendered: unknown resolution (the original screenshot)", () => {
  const markup = selector(unknownResolution());
  const visible = text(markup);

  it("explains the missing resolution and invents none", () => {
    assert.ok(visible.includes("Resolution unavailable"));
    assert.ok(
      visible.includes(
        "VideoFetch can download this source, but the source did not report a reliable video resolution.",
      ),
    );
    assert.equal(/\b\d{3,4}p\b/.test(visible), false);
  });

  it("keeps Download enabled and Advanced unavailable", () => {
    assert.equal(/\sdisabled=""/.test(downloadButton(markup)), false);
    assert.match(advancedSwitch(markup), /\sdisabled=""/);
  });
});

describe("rendered: protected renditions without a known height", () => {
  it("explains them beside a download", () => {
    const visible = text(selector(protectedUnenumerated()));
    assert.ok(visible.includes("Protected renditions detected"));
    assert.ok(
      visible.includes(
        "Additional protected renditions were detected, but their resolutions were not available during analysis.",
      ),
    );
    assert.equal(visible.includes("Highest observed"), false);
  });

  it("explains them when nothing is downloadable, keeping the base message and the button", () => {
    const visible = text(unavailable(noCompatible(quality({ protectedUnenumerated: true }))));
    assert.ok(visible.includes("No compatible download available"));
    assert.ok(
      visible.includes(
        "VideoFetch recognized this source, but none of its available streams match the download formats currently supported.",
      ),
    );
    assert.ok(
      visible.includes(
        "Protected renditions were detected, but their resolutions were not available during analysis.",
      ),
    );
    assert.equal(/\b\d{3,4}p\b/.test(visible), false);
    assert.ok(visible.includes("Try another URL"));
  });
});

describe("rendered: no compatible download with a known observed height", () => {
  it("adds the height and the reason to the unchanged base message", () => {
    const visible = text(
      unavailable(
        noCompatible(
          quality({
            observedMaxHeight: 2160,
            withheld: [{ reason: "unsupported_protocol", count: 2, maxObservedHeight: 2160 }],
          }),
        ),
      ),
    );
    assert.ok(visible.includes("No compatible download available"));
    assert.ok(visible.includes("Highest observed: 2160p"));
    assert.ok(visible.includes("No detected rendition is currently downloadable."));
    assert.ok(
      visible.includes("Some detected streams use a stream type VideoFetch does not support yet."),
    );
    assert.ok(visible.includes("Try another URL"));
  });
});

describe("rendered: legacy and direct analyses are unchanged", () => {
  it("renders the legacy no-compatible state with no note", () => {
    const markup = unavailable(noCompatible());
    assert.equal(/role="note"/.test(markup), false);
    assert.equal(
      text(markup),
      "No compatible download available VideoFetch recognized this source, but none of its available streams match the download formats currently supported. Try another URL",
    );
  });

  it("renders a pre-P1 generic analysis with no note", () => {
    const markup = selector(generic(xCasePresets()));
    assert.equal(/role="note"/.test(markup), false);
    assert.ok(text(markup).includes("Advanced unavailable for this source"));
  });

  it("keeps Advanced available and working for direct analysis", () => {
    const markup = selector(direct());
    assert.equal(/\sdisabled=""/.test(advancedSwitch(markup)), false);
    assert.equal(text(markup).includes("Advanced unavailable"), false);
    assert.equal(/role="note"/.test(markup), false);
    const advanced = text(selector(direct(), false));
    assert.ok(advanced.includes("Source format"));
  });
});
