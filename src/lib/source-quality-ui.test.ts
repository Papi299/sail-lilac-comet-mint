import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_QUALITY_WITHHELD_REASONS,
  SourceQualitySchema,
  VideoMetadataSchema,
} from "@/shared/worker/contracts";
import { hasDownloadOptions, initialSelectionId } from "./download-options.ts";
import {
  BEST_PRESET_ID,
  hasHigherObservedQuality,
  isAdvancedAvailable,
  presentNoCompatibleDownload,
  presentSourceQuality,
  presetDisplayLabel,
  qualityOptions,
} from "./source-quality-ui.ts";
import {
  GAP_2160_QUALITY,
  X_CASE_QUALITY,
  direct,
  gap2160,
  generic,
  noCompatible,
  preset,
  protectedUnenumerated,
  quality,
  unknownResolution,
  xCase,
  xCasePresets,
} from "./source-quality-ui.fixtures.ts";
import type { SourceQuality, VideoMetadata } from "@/types/media";

const HIGHER_PROTOCOL = "Higher-quality streams use a stream type VideoFetch does not support yet.";
const RESOLUTION_UNAVAILABLE =
  "VideoFetch can download this source, but the source did not report a reliable video resolution.";
const ADDITIONAL_PROTECTED =
  "Additional protected renditions were detected, but their resolutions were not available during analysis.";
const PROTECTED_UNENUMERATED =
  "Protected renditions were detected, but their resolutions were not available during analysis.";
const MAYBE_PROTECTED = "Some detected source renditions may be protected.";

/** Every string a presentation puts on screen for this analysis. */
function visibleText(video: VideoMetadata): string[] {
  const view = presentSourceQuality(video);
  const notice = view?.notice;
  // The route renders the no-compatible state only when nothing is selectable.
  const unavailable = hasDownloadOptions(video) ? null : presentNoCompatibleDownload(video);
  return [
    ...qualityOptions(video).map((o) => o.label),
    ...(notice
      ? [notice.title ?? "", ...notice.facts.flatMap((f) => [f.label, f.value]), ...notice.messages]
      : []),
    ...(unavailable
      ? [...unavailable.facts.flatMap((f) => [f.label, f.value]), ...unavailable.messages]
      : []),
  ];
}

/** A gap case whose one withheld group is `reason`, taller than the best download. */
function gapWithReason(reason: string): VideoMetadata {
  return generic(
    [preset("preset:best", "Best available", "720p"), preset("preset:720", "720p", "720p")],
    quality({
      observedMaxHeight: 2160,
      deliverableMaxHeight: 720,
      withheld: [
        { reason, count: 1, maxObservedHeight: 2160 } as SourceQuality["withheld"][number],
      ],
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("fixtures are real P1 shapes", () => {
  it("every fixture satisfies the strict shared contract", () => {
    const fixtures = [xCase(), gap2160(), unknownResolution(), protectedUnenumerated(), direct()];
    for (const video of fixtures) VideoMetadataSchema.parse(video);
    for (const sourceQuality of [X_CASE_QUALITY, GAP_2160_QUALITY])
      SourceQualitySchema.parse(sourceQuality);
  });
});

describe("1 / 14 — no sourceQuality: legacy display, exactly", () => {
  const legacy = generic(xCasePresets());

  it("has no presentation and no no-compatible context", () => {
    assert.equal(presentSourceQuality(legacy), null);
    assert.equal(presentNoCompatibleDownload(noCompatible()), null);
  });

  it("keeps Best available and every other preset label", () => {
    assert.deepEqual(
      qualityOptions(legacy).map((o) => o.label),
      ["Best available · 757 KB", "360p · 757 KB", "240p"],
    );
    for (const p of legacy.presets) assert.equal(presetDisplayLabel(p, legacy), p.label);
  });

  it("keeps direct analysis untouched", () => {
    const video = direct();
    assert.equal(presentSourceQuality(video), null);
    assert.deepEqual(qualityOptions(video), [
      { value: "preset:best", label: "Best available · 2.7 MB" },
    ]);
  });
});

describe("2 / 21 — observed == deliverable (the live X/Twitter case)", () => {
  const video = xCase();
  const view = presentSourceQuality(video)!;

  it("reports no higher-quality gap", () => {
    assert.equal(hasHigherObservedQuality(X_CASE_QUALITY), false);
    assert.equal(view.hasHigherObservedQuality, false);
    assert.deepEqual(view.explanations, []);
  });

  it("shows no notice at all", () => {
    assert.equal(view.notice, null);
    assert.equal(
      visibleText(video).some((t) => t.includes("Higher source quality")),
      false,
    );
  });

  it("labels Best by its executable rung, 360p, never the 384-pixel source height", () => {
    assert.deepEqual(qualityOptions(video), [
      { value: "preset:best", label: "Best downloadable — 360p · 757 KB" },
      { value: "preset:360", label: "360p · 757 KB" },
      { value: "preset:240", label: "240p" },
    ]);
    assert.equal(view.bestDownloadableLabel, "360p");
    assert.equal(
      visibleText(video).some((t) => t.includes("384")),
      false,
    );
  });

  it("offers no 384p and no HLS option, and still submits preset:best", () => {
    assert.deepEqual(
      qualityOptions(video).map((o) => o.value),
      ["preset:best", "preset:360", "preset:240"],
    );
    assert.equal(initialSelectionId(video), "preset:best");
    assert.equal(isAdvancedAvailable(video), false);
  });
});

describe("3 / 22 — observed > deliverable (2160 observed, 720 downloadable)", () => {
  const video = gap2160();
  const view = presentSourceQuality(video)!;

  it("reports the gap with exact facts and the protocol explanation", () => {
    assert.equal(view.hasHigherObservedQuality, true);
    assert.equal(view.highestObservedLabel, "2160p");
    assert.equal(view.bestDownloadableLabel, "720p");
    assert.deepEqual(view.explanations, [HIGHER_PROTOCOL]);
    assert.deepEqual(view.notice, {
      title: "Higher source quality detected",
      facts: [
        { label: "Highest observed", value: "2160p" },
        { label: "Best downloadable", value: "720p" },
      ],
      messages: [HIGHER_PROTOCOL],
    });
  });

  it("labels Best as the downloadable 720p and adds no 2160 option", () => {
    const options = qualityOptions(video);
    assert.equal(options[0]!.label, "Best downloadable — 720p");
    assert.deepEqual(
      options.map((o) => o.value),
      ["preset:best", "preset:720", "preset:480", "preset:360"],
    );
    assert.equal(
      options.some((o) => o.value.includes("2160") || o.label.includes("2160")),
      false,
    );
  });
});

describe("4 — observed known, deliverable null", () => {
  it("is a gap even when the only video download has no height", () => {
    const video = generic(
      [preset("preset:best", "Best available", null)],
      quality({
        observedMaxHeight: 1080,
        withheld: [{ reason: "unsupported_protocol", count: 1, maxObservedHeight: 1080 }],
      }),
    );
    VideoMetadataSchema.parse(video);
    const view = presentSourceQuality(video)!;
    assert.equal(view.hasHigherObservedQuality, true);
    assert.equal(view.resolutionUnknown, true);
    assert.deepEqual(view.notice!.facts, [
      { label: "Highest observed", value: "1080p" },
      { label: "Best downloadable", value: "Resolution unavailable" },
    ]);
    assert.deepEqual(view.notice!.messages, [HIGHER_PROTOCOL]);
    assert.equal(qualityOptions(video)[0]!.label, "Best downloadable");
  });

  it("says Audio only when only audio presets are downloadable", () => {
    const audio = preset("preset:audio", "Audio only", "audio", {
      hasVideo: false,
      videoCodec: null,
    });
    const video = generic(
      [audio],
      quality({
        observedMaxHeight: 720,
        withheld: [{ reason: "audio_pair_unavailable", count: 1, maxObservedHeight: 720 }],
      }),
    );
    VideoMetadataSchema.parse(video);
    const view = presentSourceQuality(video)!;
    assert.equal(view.resolutionUnknown, false);
    assert.deepEqual(view.notice!.facts[1], { label: "Best downloadable", value: "Audio only" });
    assert.deepEqual(qualityOptions(video), [{ value: "preset:audio", label: "Audio only" }]);
  });

  it("claims no downloadable value when there are no presets at all", () => {
    const video = generic(
      [],
      quality({
        observedMaxHeight: 720,
        withheld: [{ reason: "unsupported_protocol", count: 1, maxObservedHeight: 720 }],
      }),
    );
    assert.deepEqual(presentSourceQuality(video)!.notice!.facts, [
      { label: "Highest observed", value: "720p" },
    ]);
  });
});

describe("5 / 23 — resolution unavailable (the original screenshot)", () => {
  const video = unknownResolution();
  const view = presentSourceQuality(video)!;

  it("explains the missing resolution without inventing one", () => {
    assert.equal(view.resolutionUnknown, true);
    assert.equal(view.hasHigherObservedQuality, false);
    assert.equal(view.highestObservedLabel, null);
    assert.equal(view.bestDownloadableLabel, null);
    assert.deepEqual(view.notice, {
      title: "Resolution unavailable",
      facts: [],
      messages: [RESOLUTION_UNAVAILABLE],
    });
    assert.equal(
      visibleText(video).some((t) => /\d+p\b/.test(t)),
      false,
    );
  });

  it("still offers the executable Best, unlabelled by any height", () => {
    assert.deepEqual(qualityOptions(video), [{ value: "preset:best", label: "Best downloadable" }]);
    assert.equal(hasDownloadOptions(video), true);
    assert.equal(initialSelectionId(video), "preset:best");
    assert.equal(isAdvancedAvailable(video), false);
  });

  it('treats the direct vocabulary\'s "unknown" as no resolution', () => {
    const video = generic([preset("preset:best", "Best available", "unknown")], quality());
    assert.equal(qualityOptions(video)[0]!.label, "Best downloadable");
    assert.equal(presentSourceQuality(video)!.resolutionUnknown, true);
  });
});

describe("6 — protected renditions without a known height", () => {
  it("explains them next to a download without inventing a quality", () => {
    const view = presentSourceQuality(protectedUnenumerated())!;
    assert.equal(view.protectedUnenumerated, true);
    assert.equal(view.hasHigherObservedQuality, false);
    assert.deepEqual(view.notice, {
      title: "Protected renditions detected",
      facts: [],
      messages: [ADDITIONAL_PROTECTED],
    });
  });

  it("explains them when nothing is downloadable", () => {
    const video = noCompatible(quality({ protectedUnenumerated: true }));
    VideoMetadataSchema.parse(video);
    assert.deepEqual(presentNoCompatibleDownload(video), {
      title: null,
      facts: [],
      messages: [PROTECTED_UNENUMERATED],
    });
  });
});

describe("7 — maybe-protected renditions", () => {
  it("is a restrained, untitled note on its own", () => {
    const video = generic(xCasePresets(), { ...X_CASE_QUALITY, maybeProtectedObserved: true });
    assert.deepEqual(presentSourceQuality(video)!.notice, {
      title: null,
      facts: [],
      messages: [MAYBE_PROTECTED],
    });
  });

  it("follows the gap explanation when both apply", () => {
    const video = generic(gap2160().presets, { ...GAP_2160_QUALITY, maybeProtectedObserved: true });
    assert.deepEqual(presentSourceQuality(video)!.notice!.messages, [
      HIGHER_PROTOCOL,
      MAYBE_PROTECTED,
    ]);
  });

  it("never states positively that anything is DRM-protected", () => {
    for (const t of visibleText(
      generic(xCasePresets(), { ...X_CASE_QUALITY, maybeProtectedObserved: true }),
    )) {
      assert.equal(/DRM/i.test(t), false);
    }
  });
});

describe("8 — every closed withheld reason has safe human copy", () => {
  it("maps each reason to distinct, application-owned sentences", () => {
    const higher = new Set<string>();
    const unavailable = new Set<string>();
    for (const reason of SOURCE_QUALITY_WITHHELD_REASONS) {
      const gap = presentSourceQuality(gapWithReason(reason))!;
      assert.equal(gap.explanations.length, 1, reason);
      const [message] = gap.explanations;
      higher.add(message!);

      const none = presentNoCompatibleDownload(
        noCompatible(
          quality({
            observedMaxHeight: 720,
            withheld: [{ reason, count: 1, maxObservedHeight: 720 }],
          }),
        ),
      )!;
      unavailable.add(none.messages[1]!);

      for (const text of [message!, none.messages[1]!]) {
        // "protected" is also plain English; every other token is snake_case.
        assert.notEqual(text, reason, `${reason} leaked`);
        assert.equal(text.includes("_"), false, `${reason} leaked`);
        assert.match(text, /^[A-Z].*\.$/);
        assert.equal(/selector|protocol|HMAC|execution plan|yt-dlp/i.test(text), false, text);
      }
    }
    assert.equal(higher.size, SOURCE_QUALITY_WITHHELD_REASONS.length);
    assert.equal(unavailable.size, SOURCE_QUALITY_WITHHELD_REASONS.length);
  });

  it("frames gap copy as higher quality, and no-download copy without that claim", () => {
    for (const reason of SOURCE_QUALITY_WITHHELD_REASONS) {
      assert.match(
        presentSourceQuality(gapWithReason(reason))!.explanations[0]!,
        /higher-quality/i,
      );
      const none = presentNoCompatibleDownload(
        noCompatible(quality({ withheld: [{ reason, count: 1, maxObservedHeight: null }] })),
      )!;
      assert.equal(/higher/i.test(none.messages.join(" ")), false, reason);
    }
  });

  it("never renders a reason outside the vocabulary", () => {
    for (const hostile of [
      "hls_native",
      "<img src=x onerror=alert(1)>",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      const gap = presentSourceQuality(gapWithReason(hostile))!;
      assert.deepEqual(gap.explanations, [
        "Some higher-quality source renditions are not currently supported.",
      ]);
      const text = visibleText(gapWithReason(hostile)).join(" ");
      assert.equal(text.includes(hostile), false, hostile);
    }
  });
});

describe("9 — only withheld groups ABOVE the download explain the gap", () => {
  const video = generic(
    [preset("preset:best", "Best available", "1080p"), preset("preset:1080", "1080p", "1080p")],
    quality({
      observedMaxHeight: 2160,
      deliverableMaxHeight: 1080,
      withheld: [
        { reason: "unsupported_protocol", count: 3, maxObservedHeight: 720 },
        { reason: "unsafe_selector_identity", count: 1, maxObservedHeight: null },
        { reason: "size_limit_exceeded", count: 1, maxObservedHeight: 2160 },
        { reason: "not_selected", count: 1, maxObservedHeight: 1080 },
      ],
    }),
  );

  it("explains the 2160 group and ignores lower, equal and unknown-height groups", () => {
    VideoMetadataSchema.parse(video);
    assert.deepEqual(presentSourceQuality(video)!.explanations, [
      "Some higher-quality streams exceed VideoFetch's current download size limit.",
    ]);
  });
});

describe("10 — duplicate human explanations are deduplicated", () => {
  it("shows each sentence once", () => {
    const video = generic(
      [preset("preset:best", "Best available", "720p")],
      // Hand-built past the schema, which would reject the repeats.
      quality({
        observedMaxHeight: 2160,
        deliverableMaxHeight: 720,
        withheld: [
          { reason: "unsupported_protocol", count: 1, maxObservedHeight: 1080 },
          { reason: "unsupported_protocol", count: 1, maxObservedHeight: 2160 },
          { reason: "other_unsupported", count: 1, maxObservedHeight: 1440 },
          { reason: "not_a_reason", count: 1, maxObservedHeight: 1440 } as never,
        ],
      }),
    );
    assert.deepEqual(presentSourceQuality(video)!.explanations, [
      HIGHER_PROTOCOL,
      "Some higher-quality source renditions are not currently supported.",
    ]);
    const none = presentNoCompatibleDownload(noCompatible(video.sourceQuality))!;
    assert.equal(new Set(none.messages).size, none.messages.length);
  });
});

describe("11 — observed heights stay exact informational facts", () => {
  it("does not round a non-standard height to a rung", () => {
    assert.equal(presentSourceQuality(xCase())!.highestObservedLabel, "384p");
    const video = generic(
      [preset("preset:best", "Best available", "720p")],
      quality({
        observedMaxHeight: 1600,
        deliverableMaxHeight: 720,
        withheld: [{ reason: "unsupported_protocol", count: 1, maxObservedHeight: 1600 }],
      }),
    );
    assert.deepEqual(presentSourceQuality(video)!.notice!.facts[0], {
      label: "Highest observed",
      value: "1600p",
    });
  });
});

describe("12 — Best uses the executable preset's rung, not deliverableMaxHeight", () => {
  it("keeps the preset's rung when the source height is between rungs", () => {
    const video = generic(
      [preset("preset:best", "Best available", "720p"), preset("preset:720", "720p", "720p")],
      quality({
        observedMaxHeight: 2160,
        deliverableMaxHeight: 1000,
        withheld: [{ reason: "unsupported_protocol", count: 1, maxObservedHeight: 2160 }],
      }),
    );
    VideoMetadataSchema.parse(video);
    assert.equal(qualityOptions(video)[0]!.label, "Best downloadable — 720p");
    assert.equal(presentSourceQuality(video)!.notice!.facts[1]!.value, "720p");
  });

  it("changes only preset:best, and nothing but its label", () => {
    const video = gap2160();
    for (const p of video.presets) {
      const expected = p.id === BEST_PRESET_ID ? "Best downloadable — 720p" : p.label;
      assert.equal(presetDisplayLabel(p, video), expected);
    }
  });
});

describe("13 / 16 / 17 — sourceQuality never creates, removes or alters a selectable value", () => {
  const cases = [
    xCase(),
    gap2160(),
    unknownResolution(),
    protectedUnenumerated(),
    direct(),
    noCompatible(GAP_2160_QUALITY),
  ];

  it("offers exactly one option per preset, valued by the preset id, in order", () => {
    for (const video of cases) {
      assert.deepEqual(
        qualityOptions(video).map((o) => o.value),
        video.presets.map((p) => p.id),
      );
    }
  });

  it("selects and detects options identically with and without P1 metadata", () => {
    for (const video of cases) {
      const { sourceQuality: _omitted, ...legacy } = video;
      assert.equal(initialSelectionId(video), initialSelectionId(legacy));
      assert.equal(hasDownloadOptions(video), hasDownloadOptions(legacy));
      assert.deepEqual(
        qualityOptions(video).map((o) => o.value),
        qualityOptions(legacy).map((o) => o.value),
      );
    }
  });

  it("never mutates the analysis: ids, formatIds and labels are the Worker's", () => {
    for (const video of cases) {
      const before = structuredClone(video);
      const frozen = deepFreeze(video);
      qualityOptions(frozen);
      presentSourceQuality(frozen);
      presentNoCompatibleDownload(frozen);
      for (const p of frozen.presets) presetDisplayLabel(p, frozen);
      isAdvancedAvailable(frozen);
      assert.deepEqual(frozen, before);
    }
    const best = gap2160().presets[0]!;
    assert.equal(best.label, "Best available");
    assert.equal(best.formatId, "preset:best");
  });
});

describe("15 / 16 — Advanced is available only with a raw format list", () => {
  it("is unavailable for generic analysis, which sends formats: []", () => {
    for (const video of [xCase(), gap2160(), unknownResolution(), generic(xCasePresets())]) {
      assert.equal(isAdvancedAvailable(video), false);
    }
  });

  it("stays available for direct analysis, which lists its format", () => {
    assert.equal(isAdvancedAvailable(direct()), true);
  });
});

describe("19 — no compatible download, with P1 context", () => {
  it("adds the observed height and why nothing is downloadable", () => {
    const video = noCompatible(
      quality({
        observedMaxHeight: 2160,
        withheld: [
          { reason: "unsupported_protocol", count: 2, maxObservedHeight: 2160 },
          { reason: "split_pair_unsupported", count: 1, maxObservedHeight: 1080 },
        ],
      }),
    );
    VideoMetadataSchema.parse(video);
    assert.deepEqual(presentNoCompatibleDownload(video), {
      title: null,
      facts: [{ label: "Highest observed", value: "2160p" }],
      messages: [
        "No detected rendition is currently downloadable.",
        "Some detected streams use a stream type VideoFetch does not support yet.",
        "Video and audio streams were detected, but VideoFetch cannot combine that pairing yet.",
      ],
    });
  });

  it("adds nothing when P1 metadata carries nothing to say", () => {
    assert.equal(presentNoCompatibleDownload(noCompatible(quality())), null);
  });
});
