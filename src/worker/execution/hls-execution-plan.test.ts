import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import {
  SOURCE_QUALITY_MAX_HEIGHT,
  SOURCE_QUALITY_WITHHELD_REASONS,
  WORKER_REQUESTED_FORMAT_IDS,
} from "@/shared/worker/contracts";
import { HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT } from "../hls/hls-processing.server.ts";
import {
  CLEAR_HLS_SHADOW_PRESET_ID_PATTERN,
  type ClearHlsMediaPlaylistSelection,
  type ClearHlsMediaPlaylistSelections,
} from "../hls/hls-source-selection.ts";
import { YTDLP_V1_NATIVE_PROTOCOLS } from "../analysis/ytdlp-analysis.server.ts";
import { GENERIC_SOURCE_PROTOCOLS, type GenericSourceSelections } from "./generic-source.ts";
import {
  CLEAR_HLS_TARGET_CONTAINER,
  ClearHlsVideoPresetIdSchema,
  GENERIC_SPLIT_VIDEO_PRESET_IDS,
  deriveClearHlsExecutionPlan,
  deriveExecutionPlan,
  executionPlanRequestedFormatId,
  executionPlanRequiresProcessing,
  executionPlanTargetContainer,
  snapshotClearHlsSelection,
  type ClearHlsExecutionPlan,
  type GenericSingleSourceExecutionPlan,
  type GenericSplitExecutionPlan,
} from "./format-plan.ts";
import { workspaceFootprintForPlan } from "./workspace-capacity.ts";
import type { downloadGenericOriginal } from "./ytdlp-download.server.ts";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";

/**
 * HLS-6: the clear-HLS EXECUTION PLAN — representation, derivation, and the
 * dormancy that must survive both.
 *
 * Everything here is pure. No network, no filesystem, no subprocess, no store.
 * The lifecycle cases live in `hls-job-execution.server.test.ts`, and the
 * HLS-2/HLS-3 failure mapping in `worker/hls/hls-execution.server.test.ts`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A conspicuous sentinel standing in for the signed part of a real playlist
 * URL. Every privacy case searches for THIS string, so a leak anywhere is
 * unmissable rather than a judgement call about what looks sensitive.
 */
const VERY_PRIVATE_HLS_TOKEN = "VERY_PRIVATE_HLS_TOKEN";
const PLAYLIST_URL = `https://media.example.invalid/hls/1080/media.m3u8?sig=${VERY_PRIVATE_HLS_TOKEN}`;

/** Exactly what HLS-5 constructs: a frozen two-field object literal. */
function selection(
  playlistUrl: string = PLAYLIST_URL,
  height: number | null = 1080,
): ClearHlsMediaPlaylistSelection {
  return Object.freeze({ playlistUrl, height });
}

/** A frozen shadow map, exactly as HLS-5 returns one. */
function shadow(
  entries: Record<string, ClearHlsMediaPlaylistSelection>,
): ClearHlsMediaPlaylistSelections {
  return Object.freeze({ ...entries });
}

function expectFormatUnavailable(run: () => unknown, label: string): AppError {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof AppError, `${label}: must be an AppError`);
    assert.equal(err.code, "FORMAT_UNAVAILABLE", label);
    return err;
  }
  assert.fail(`${label}: expected a refusal`);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. THE REQUESTED-ID VOCABULARY (§6)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 plan vocabulary: video presets only, MP4 always", () => {
  it("is exactly the nine video rungs", () => {
    assert.deepEqual(
      [...ClearHlsVideoPresetIdSchema.options],
      [
        "preset:best",
        "preset:2160",
        "preset:1440",
        "preset:1080",
        "preset:720",
        "preset:480",
        "preset:360",
        "preset:240",
        "preset:144",
      ],
    );
  });

  it("is the SAME list the split vocabulary uses, not a third copy", () => {
    // Reused rather than restated: both mean "the application's video ladder",
    // and a third copy would be a third place to forget when a rung changes.
    assert.deepEqual([...ClearHlsVideoPresetIdSchema.options], [...GENERIC_SPLIT_VIDEO_PRESET_IDS]);
  });

  it("agrees exactly with the HLS-5 shadow-map key vocabulary", () => {
    // The derivation indexes the shadow map by these ids, so a key HLS-5 can
    // emit that this cannot represent would be a silently unreachable rung.
    for (const id of ClearHlsVideoPresetIdSchema.options) {
      assert.match(id, CLEAR_HLS_SHADOW_PRESET_ID_PATTERN, id);
    }
  });

  it("cannot represent an audio product or a concrete format", () => {
    for (const id of ["preset:audio", "preset:mp3", "direct-original"]) {
      assert.equal(ClearHlsVideoPresetIdSchema.safeParse(id).success, false, id);
    }
  });

  it("targets mp4 and nothing else", () => {
    assert.equal(CLEAR_HLS_TARGET_CONTAINER, "mp4");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. THE PROVENANCE SNAPSHOT (§7)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 snapshot: one HLS-5 selection, parsed rather than trusted", () => {
  it("captures a well-formed selection into a frozen snapshot of its own", () => {
    const input = selection();
    const snap = snapshotClearHlsSelection(input);
    assert.ok(snap);
    assert.equal(snap.playlistUrl, PLAYLIST_URL);
    assert.equal(snap.height, 1080);
    assert.ok(Object.isFrozen(snap));
    assert.notEqual(snap, input, "the snapshot is this module's own object");
  });

  it("accepts a null height — an unknown-height rendition is still selectable", () => {
    assert.equal(snapshotClearHlsSelection(selection(PLAYLIST_URL, null))?.height, null);
  });

  it("refuses every non-object and a null", () => {
    for (const value of [null, undefined, "", PLAYLIST_URL, 0, 1080, true, Symbol("s")]) {
      assert.equal(snapshotClearHlsSelection(value), null, String(value?.toString?.() ?? value));
    }
  });

  it("refuses an UNFROZEN object, even a structurally perfect one", () => {
    assert.equal(snapshotClearHlsSelection({ playlistUrl: PLAYLIST_URL, height: 1080 }), null);
  });

  it("refuses an exotic prototype: null-prototype, class instance, array", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.playlistUrl = PLAYLIST_URL;
    bare.height = 1080;
    assert.equal(snapshotClearHlsSelection(Object.freeze(bare)), null);

    class Selection {
      playlistUrl = PLAYLIST_URL;
      height: number | null = 1080;
    }
    assert.equal(snapshotClearHlsSelection(Object.freeze(new Selection())), null);
    assert.equal(snapshotClearHlsSelection(Object.freeze([PLAYLIST_URL, 1080])), null);
  });

  it("refuses an UNEXPECTED extra property, however it is hidden", () => {
    const extra = Object.freeze({ playlistUrl: PLAYLIST_URL, height: 1080, referer: "x" });
    assert.equal(snapshotClearHlsSelection(extra), null, "a plain extra");

    // `Object.keys()` would see neither of the next two. `Reflect.ownKeys()`
    // does, which is why the count is taken with it.
    const symbolPayload: Record<string | symbol, unknown> = {
      playlistUrl: PLAYLIST_URL,
      height: 1080,
    };
    symbolPayload[Symbol("cookies")] = "SESSION=1";
    assert.equal(snapshotClearHlsSelection(Object.freeze(symbolPayload)), null, "a symbol key");

    const hidden = { playlistUrl: PLAYLIST_URL, height: 1080 };
    Object.defineProperty(hidden, "headers", { value: {}, enumerable: false });
    assert.equal(
      snapshotClearHlsSelection(Object.freeze(hidden)),
      null,
      "a non-enumerable extra",
    );
  });

  it("refuses an ACCESSOR-backed field WITHOUT invoking it", () => {
    let getterCalls = 0;
    const hostile = Object.freeze(
      Object.defineProperties({} as Record<string, unknown>, {
        playlistUrl: {
          enumerable: true,
          get() {
            getterCalls += 1;
            // A getter that answers differently every time is exactly the
            // substitution a validate-then-reread guard could not survive.
            return getterCalls === 1 ? PLAYLIST_URL : "https://attacker.example.invalid/m.m3u8";
          },
        },
        height: { enumerable: true, value: 1080 },
      }),
    );
    assert.equal(snapshotClearHlsSelection(hostile), null);
    assert.equal(getterCalls, 0, "refusing a getter must never run it");
  });

  it("refuses an INHERITED field standing in for an own one", () => {
    const proto = { playlistUrl: PLAYLIST_URL, height: 1080 };
    const child = Object.freeze(Object.create(proto) as Record<string, unknown>);
    assert.equal(snapshotClearHlsSelection(child), null);
  });

  it("refuses a URL that HLS-5's own static policy would not return unchanged", () => {
    for (const [label, url] of [
      ["relative", "/hls/media.m3u8"],
      ["protocol-relative", "//cdn.example.invalid/media.m3u8"],
      ["not http(s)", "file:///etc/passwd"],
      ["data:", "data:text/plain,hello"],
      ["credentialed", "https://user:pass@media.example.invalid/m.m3u8"],
      ["single-label host", "https://localhost/m.m3u8"],
      ["a private literal", "https://127.0.0.1/m.m3u8"],
      ["empty", ""],
    ] as const) {
      assert.equal(snapshotClearHlsSelection(selection(url)), null, label);
    }
  });

  it("refuses a URL that would only be accepted AFTER canonicalisation", () => {
    // The `===` comparison is the point: a value whose accepted serialisation
    // differs from what was retained is refused, never silently rewritten, so
    // this function can never validate one URL and hand back another.
    const needsTrimming = ` ${PLAYLIST_URL} `;
    assert.equal(snapshotClearHlsSelection(selection(needsTrimming)), null);
  });

  it("refuses a height outside HLS-5's observed-height contract", () => {
    for (const height of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      SOURCE_QUALITY_MAX_HEIGHT + 1,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      assert.equal(snapshotClearHlsSelection(selection(PLAYLIST_URL, height)), null, String(height));
    }
    // The exact boundary is IN.
    assert.equal(
      snapshotClearHlsSelection(selection(PLAYLIST_URL, SOURCE_QUALITY_MAX_HEIGHT))?.height,
      SOURCE_QUALITY_MAX_HEIGHT,
    );
    assert.equal(snapshotClearHlsSelection(selection(PLAYLIST_URL, 1))?.height, 1);
  });

  it("refuses a non-number, non-null height", () => {
    // Built literally rather than through `selection()`, whose default would
    // silently repair an `undefined`.
    for (const height of ["1080", undefined, {}, []]) {
      assert.equal(
        snapshotClearHlsSelection(Object.freeze({ playlistUrl: PLAYLIST_URL, height })),
        null,
        String(height),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. DERIVATION (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 derivation: the exact rung, or nothing", () => {
  it("builds the fixed MP4 plan for an advertised rung", () => {
    const plan = deriveClearHlsExecutionPlan(shadow({ "preset:1080": selection() }), "preset:1080");
    assert.deepEqual(plan, {
      strategy: "yt-dlp",
      operation: "clear-hls-remux",
      requestedFormatId: "preset:1080",
      source: { playlistUrl: PLAYLIST_URL, height: 1080 },
      targetContainer: "mp4",
    });
  });

  it("answers the shared plan accessors correctly", () => {
    const plan = deriveClearHlsExecutionPlan(shadow({ "preset:720": selection() }), "preset:720");
    const wrapped = { strategy: "yt-dlp", generic: plan } as const;
    assert.equal(executionPlanTargetContainer(wrapped), "mp4");
    assert.equal(executionPlanRequestedFormatId(wrapped), "preset:720");
    assert.equal(
      executionPlanRequiresProcessing(wrapped),
      true,
      "an HLS job always remuxes after beginProcessing()",
    );
  });

  it("freezes the plan and its source", () => {
    const plan = deriveClearHlsExecutionPlan(shadow({ "preset:best": selection() }), "preset:best");
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.source));
  });

  it("is detached from the analysis map: later mutation cannot redirect it", () => {
    const entry = { playlistUrl: PLAYLIST_URL, height: 1080 };
    const map: Record<string, ClearHlsMediaPlaylistSelection> = {
      "preset:1080": Object.freeze(entry),
    };
    const plan = deriveClearHlsExecutionPlan(map, "preset:1080");

    // Replace the whole entry with a hostile one AFTER derivation.
    map["preset:1080"] = Object.freeze({
      playlistUrl: "https://attacker.example.invalid/m.m3u8",
      height: 1080,
    });
    assert.equal(plan.source.playlistUrl, PLAYLIST_URL, "the plan holds its own captured value");

    // And the plan itself cannot be rewritten in place.
    assert.throws(() => {
      "use strict";
      (plan.source as { playlistUrl: string }).playlistUrl = "https://attacker.example.invalid/x";
    });
    assert.equal(plan.source.playlistUrl, PLAYLIST_URL);
  });

  it("refuses a rung the map does not carry — with NO substitution", () => {
    // Every plausible substitution is present and must be ignored: a lower
    // rung, a higher rung, and `preset:best`.
    const map = shadow({
      "preset:best": selection("https://media.example.invalid/best.m3u8", 2160),
      "preset:2160": selection("https://media.example.invalid/2160.m3u8", 2160),
      "preset:720": selection("https://media.example.invalid/720.m3u8", 720),
    });
    expectFormatUnavailable(
      () => deriveClearHlsExecutionPlan(map, "preset:1080"),
      "an absent rung must never fall back",
    );
  });

  it("refuses an EMPTY map", () => {
    expectFormatUnavailable(() => deriveClearHlsExecutionPlan(shadow({}), "preset:best"), "empty");
  });

  it("refuses every id outside the closed video vocabulary", () => {
    const map = shadow({
      "preset:1080": selection(),
      // Present in the map and still unrepresentable: the vocabulary, not the
      // map, is what decides.
      "preset:audio": selection(),
    });
    for (const id of [
      "preset:audio",
      "preset:mp3",
      "direct-original",
      "",
      "preset:",
      "preset:1081",
      "PRESET:1080",
      "preset:1080 ",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expectFormatUnavailable(() => deriveClearHlsExecutionPlan(map, id), `id ${JSON.stringify(id)}`);
    }
  });

  it("refuses a non-string requested id", () => {
    for (const id of [null, undefined, 1080, {}, []]) {
      expectFormatUnavailable(
        () => deriveClearHlsExecutionPlan(shadow({ "preset:1080": selection() }), id as never),
        String(id),
      );
    }
  });

  it("requires an OWN data property: an inherited entry is not a selection", () => {
    const proto: Record<string, ClearHlsMediaPlaylistSelection> = { "preset:1080": selection() };
    const inherited = Object.create(proto) as ClearHlsMediaPlaylistSelections;
    expectFormatUnavailable(
      () => deriveClearHlsExecutionPlan(inherited, "preset:1080"),
      "an inherited entry",
    );
  });

  it("refuses an ACCESSOR map entry without invoking it", () => {
    let reads = 0;
    const map = Object.defineProperty({}, "preset:1080", {
      enumerable: true,
      get() {
        reads += 1;
        return selection();
      },
    }) as ClearHlsMediaPlaylistSelections;
    expectFormatUnavailable(
      () => deriveClearHlsExecutionPlan(map, "preset:1080"),
      "an accessor entry",
    );
    assert.equal(reads, 0);
  });

  it("refuses a malformed selection behind a valid key", () => {
    for (const [label, value] of [
      ["unfrozen", { playlistUrl: PLAYLIST_URL, height: 1080 }],
      ["a bare string", PLAYLIST_URL],
      ["null", null],
      ["an extra field", Object.freeze({ playlistUrl: PLAYLIST_URL, height: 1080, cookie: "x" })],
      ["a bad URL", Object.freeze({ playlistUrl: "ftp://media.example.invalid/m.m3u8", height: 1 })],
      ["a bad height", Object.freeze({ playlistUrl: PLAYLIST_URL, height: 0 })],
    ] as const) {
      expectFormatUnavailable(
        () =>
          deriveClearHlsExecutionPlan(
            { "preset:1080": value as ClearHlsMediaPlaylistSelection },
            "preset:1080",
          ),
        label,
      );
    }
  });

  it("refuses a non-object map", () => {
    for (const map of [null, undefined, "x", 1]) {
      expectFormatUnavailable(
        () => deriveClearHlsExecutionPlan(map as never, "preset:1080"),
        String(map),
      );
    }
  });

  it("never puts the playlist URL in a refusal", () => {
    const err = expectFormatUnavailable(
      () =>
        deriveClearHlsExecutionPlan(
          { "preset:1080": { playlistUrl: PLAYLIST_URL, height: 1080 } },
          "preset:1080",
        ),
      "an unfrozen selection",
    );
    const serialized = `${err.message}\n${err.stack ?? ""}\n${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
    assert.equal(serialized.includes(VERY_PRIVATE_HLS_TOKEN), false, "no token in the error");
    assert.equal(serialized.includes("media.example.invalid"), false, "no host in the error");
    assert.equal(err.message, ERROR_MESSAGES.FORMAT_UNAVAILABLE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. TYPE PARTITIONS (§11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CORRECTION-01: the plan parameter of the EXPORTED progressive downloader, read
 * off the function itself rather than restated.
 *
 * Taking it from `Parameters<typeof downloadGenericOriginal>[2]` is the whole
 * point: widening that signature back to `GenericExecutionPlan` changes this
 * type, and the three assertions below then fail `tsc`. A test that named the
 * partition type directly would keep passing while the real boundary was open.
 */
type ProgressiveDownloadPlan = Parameters<typeof downloadGenericOriginal>[2];

/** `false` unless the plan family is assignable to that parameter. */
type HlsFitsProgressiveDownloader =
  ClearHlsExecutionPlan extends ProgressiveDownloadPlan ? true : false;
type SplitFitsProgressiveDownloader =
  GenericSplitExecutionPlan extends ProgressiveDownloadPlan ? true : false;
type SingleFitsProgressiveDownloader =
  GenericSingleSourceExecutionPlan extends ProgressiveDownloadPlan ? true : false;

// THE COMPILE-TIME BOUNDARY. Each annotation is checked by `tsc`, so these three
// lines fail the typecheck — not merely an assertion — the moment the exported
// downloader readmits a plan family it must not accept.
const hlsRejectedByDownloader: false = false as HlsFitsProgressiveDownloader;
const splitRejectedByDownloader: false = false as SplitFitsProgressiveDownloader;
const singleAcceptedByDownloader: true = true as SingleFitsProgressiveDownloader;

describe("HLS-6 partitions: three disjoint plan families", () => {
  it("keeps an HLS plan out of the EXPORTED progressive downloader, at compile time", () => {
    // The real assertions are the three annotations above, which `tsc` checks.
    // These runtime reads exist so the case appears in the suite and so the
    // constants cannot be deleted as unused.
    assert.equal(hlsRejectedByDownloader, false, "an HLS plan must not fit the yt-dlp downloader");
    assert.equal(splitRejectedByDownloader, false, "a split plan must not fit it either");
    assert.equal(singleAcceptedByDownloader, true, "the single-source partition must still fit");
  });

  it("keeps an HLS plan out of the single-source yt-dlp partition", () => {
    // A compile-time statement, asserted here so the intent is visible in the
    // suite too: if `GenericSingleSourceExecutionPlan` ever readmitted
    // `clear-hls-remux`, this assignment would start type-checking.
    type SingleOperations = GenericSingleSourceExecutionPlan["operation"];
    const singleOperations: SingleOperations[] = [
      "keep-original",
      "extract-m4a",
      "extract-mp3",
    ];
    assert.deepEqual(singleOperations.includes("merge-split" as SingleOperations), false);
    assert.deepEqual(singleOperations.includes("clear-hls-remux" as SingleOperations), false);
  });

  it("keeps the split partition to merge-split alone", () => {
    const splitOperation: GenericSplitExecutionPlan["operation"] = "merge-split";
    assert.equal(splitOperation, "merge-split");
  });

  it("gives the HLS partition exactly one operation", () => {
    const hlsOperation: ClearHlsExecutionPlan["operation"] = "clear-hls-remux";
    assert.equal(hlsOperation, "clear-hls-remux");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. WORKSPACE (§12)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 workspace: an HLS plan costs two ceilings", () => {
  const plan = deriveClearHlsExecutionPlan(shadow({ "preset:1080": selection() }), "preset:1080");

  it("reports footprint 2", () => {
    assert.equal(workspaceFootprintForPlan({ strategy: "yt-dlp", generic: plan }), 2);
  });

  it("equals HLS-4's own accepted statement, so the two cannot drift", () => {
    assert.equal(
      workspaceFootprintForPlan({ strategy: "yt-dlp", generic: plan }),
      HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. DORMANCY: the ordinary planner stays HLS-blind (§9, §25)
// ─────────────────────────────────────────────────────────────────────────────

function genericMeta(
  presets: { id: string; container: string; hasVideo: boolean; hasAudio?: boolean }[],
): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "A Clip",
    thumbnail: null,
    duration: 60,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: "https://example.invalid/watch/abc",
    formats: [],
    presets: presets.map((p) => ({
      id: p.id,
      label: p.id,
      resolution: p.hasVideo ? "1080p" : "audio",
      container: p.container,
      fileSize: null,
      hasVideo: p.hasVideo,
      hasAudio: p.hasAudio ?? true,
      formatId: p.id,
      videoCodec: p.hasVideo ? "h264" : null,
      audioCodec: "aac",
      fps: null,
    })),
    capabilities: { mp3: true, merge: false },
  });
}

const progressiveSelections: GenericSourceSelections = {
  "preset:1080": {
    kind: "single",
    source: {
      formatId: "137",
      protocol: "https",
      container: "mp4",
      hasVideo: true,
      hasAudio: true,
      videoConstraint: "codec-present",
      audioConstraint: "codec-present",
      fileSize: null,
    },
  },
};

describe("HLS-6 dormancy: ordinary derivation cannot reach HLS", () => {
  it("HLS-ONLY analysis still fails, although the shadow rung exists", () => {
    // The document HLS-7 will eventually serve: nothing progressive is
    // advertised, and the private HLS map has exactly the requested rung.
    const analysis = {
      strategy: "yt-dlp" as const,
      video: genericMeta([]),
      selections: {},
      hlsSelections: shadow({ "preset:1080": selection() }),
    };
    assert.ok(analysis.hlsSelections["preset:1080"], "the shadow rung is genuinely present");
    // …and the dormant derivation WOULD produce a plan for it.
    assert.equal(
      deriveClearHlsExecutionPlan(analysis.hlsSelections, "preset:1080").operation,
      "clear-hls-remux",
    );
    // The ordinary planner still refuses.
    expectFormatUnavailable(
      () => deriveExecutionPlan(analysis, "preset:1080"),
      "HLS-only must stay unavailable until HLS-7",
    );
  });

  it("MIXED analysis stays on the progressive source, whatever HLS offers", () => {
    const analysis = {
      strategy: "yt-dlp" as const,
      video: genericMeta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
      selections: progressiveSelections,
      // A taller, more tempting HLS rendition on the same rung.
      hlsSelections: shadow({
        "preset:1080": selection("https://media.example.invalid/hls/2160.m3u8", 2160),
        "preset:best": selection("https://media.example.invalid/hls/2160.m3u8", 2160),
      }),
    };

    const plan = deriveExecutionPlan(analysis, "preset:1080");
    assert.equal(plan.strategy, "yt-dlp");
    assert.equal(plan.strategy === "yt-dlp" ? plan.generic.operation : null, "keep-original");
    assert.notEqual(
      plan.strategy === "yt-dlp" ? plan.generic.operation : null,
      "clear-hls-remux",
    );
    assert.equal(
      JSON.stringify(plan).includes(VERY_PRIVATE_HLS_TOKEN),
      false,
      "no HLS provenance reaches an ordinary plan",
    );
  });

  it("does not fall back to HLS when the progressive selection is missing", () => {
    const analysis = {
      strategy: "yt-dlp" as const,
      // The preset is ADVERTISED but its private selection is gone — the exact
      // shape a mid-flight site change produces, and the most tempting moment
      // to substitute.
      video: genericMeta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
      selections: {},
      hlsSelections: shadow({ "preset:1080": selection() }),
    };
    expectFormatUnavailable(() => deriveExecutionPlan(analysis, "preset:1080"), "no HLS fallback");
  });

  it("refuses a hand-crafted durable row naming an HLS-only rung", () => {
    const analysis = {
      strategy: "yt-dlp" as const,
      video: genericMeta([]),
      selections: {},
      hlsSelections: shadow({
        "preset:best": selection(),
        "preset:144": selection("https://media.example.invalid/hls/144.m3u8", 144),
      }),
    };
    for (const id of ["preset:best", "preset:144", "preset:2160"]) {
      expectFormatUnavailable(() => deriveExecutionPlan(analysis, id), id);
    }
  });

  it("is unaffected by the shadow map on the DIRECT path", () => {
    const analysis = {
      strategy: "direct" as const,
      video: VideoMetadataSchema.parse({
        title: "Direct",
        thumbnail: null,
        duration: 10,
        source: "example.invalid",
        extractor: "direct",
        webpageUrl: "https://example.invalid/a.mp4",
        formats: [
          {
            id: "direct-original",
            resolution: "1080p",
            width: 1920,
            height: 1080,
            fps: null,
            container: "mp4",
            videoCodec: "h264",
            audioCodec: "aac",
            bitrate: null,
            fileSize: null,
            hasVideo: true,
            hasAudio: true,
          },
        ],
        presets: [],
        capabilities: { mp3: false, merge: false },
      }),
      selections: {},
      hlsSelections: shadow({ "preset:1080": selection() }),
    };
    const plan = deriveExecutionPlan(analysis, "direct-original");
    assert.equal(plan.strategy, "direct");
    assert.equal(JSON.stringify(plan).includes(VERY_PRIVATE_HLS_TOKEN), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. STRUCTURAL PRODUCTION DORMANCY (§25) AND THE HLS-7 BARRIER (§44)
// ─────────────────────────────────────────────────────────────────────────────

/** Every non-test TypeScript file under `src/`. */
function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("HLS-6 structural dormancy: the machinery exists and stays unadvertised", () => {
  it("leaves both protocol policies exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("keeps HLS publicly withheld as unsupported_protocol", () => {
    assert.ok((SOURCE_QUALITY_WITHHELD_REASONS as readonly string[]).includes("unsupported_protocol"));
  });

  it("adds no public HLS preset or requested-format id", () => {
    for (const id of WORKER_REQUESTED_FORMAT_IDS) {
      assert.equal(/hls|m3u8|playlist/i.test(id), false, id);
    }
  });

  it("puts no HLS plan or provenance into any public contract", () => {
    for (const rel of [
      "src/shared/worker/contracts.ts",
      "src/shared/worker/errors.ts",
      "src/worker/state/job-store.ts",
      "src/worker/state/sqlite-job-store.server.ts",
    ]) {
      const source = read(rel);
      for (const forbidden of [
        "hlsSelections",
        "playlistUrl",
        "clear-hls-remux",
        "ClearHlsExecutionPlan",
      ]) {
        assert.equal(source.includes(forbidden), false, `${rel} must not name ${forbidden}`);
      }
    }
  });

  it("leaves the browser-facing tree with no HLS execution concept at all", () => {
    for (const file of productionSourceFiles()) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (!rel.startsWith("src/web/") && !rel.startsWith("src/components/")) continue;
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["hlsSelections", "clear-hls-remux", "playlistUrl"]) {
        assert.equal(source.includes(forbidden), false, `${rel} must not name ${forbidden}`);
      }
    }
  });

  it("adds NO activation flag anywhere in production source", () => {
    // Dormancy is structural. There is deliberately no boolean an operator
    // could flip, and therefore none they could forget to leave false.
    for (const file of productionSourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        "HLS_ENABLED",
        "ENABLE_HLS",
        "CLEAR_HLS_ENABLED",
        "hlsEnabled",
        "enableHls",
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `${relative(ROOT, file)} must not define an HLS activation switch`,
        );
      }
    }
  });

  it("does not let the Production runtime inject an HLS-aware plan derivation", () => {
    const runtime = read("src/worker/runtime/runtime.server.ts");
    assert.equal(runtime.includes("derivePlanForExecution"), false);
    assert.equal(runtime.includes("acquireClearHls"), false);
    assert.equal(runtime.includes("processClearHls"), false);
    assert.equal(runtime.includes("ClearHls"), false);
    assert.equal(runtime.includes("hls"), false, "the runtime names no HLS concept whatsoever");
  });

  /**
   * §44: THE HLS-7 ACTIVATION BARRIER.
   *
   * HLS-6 assembles execution machinery but does not activate it. The normal
   * Product planner must not consume `hlsSelections` until HLS-7.
   *
   * This case is DESIGNED TO FAIL when someone implements HLS-7. That is its
   * purpose: activation must be an explicit, reviewed edit to this gate, not
   * something that happens because a planner quietly grew a branch.
   */
  it("HLS-6 assembles execution machinery but does not activate it", () => {
    const planner = read("src/worker/execution/format-plan.ts");

    // The machinery exists…
    assert.ok(planner.includes("export function deriveClearHlsExecutionPlan"));
    assert.ok(planner.includes('operation: z.literal("clear-hls-remux")'));

    // …and no production module CALLS it. The declaring module is excluded, and
    // its own declaration would not match anyway: a call site is not preceded
    // by `function`.
    const declaringModule = join(ROOT, "src/worker/execution/format-plan.ts");
    const callers = productionSourceFiles()
      .filter((file) => file !== declaringModule)
      .filter((file) => /(?<!function\s)\bderiveClearHlsExecutionPlan\s*\(/.test(readFileSync(file, "utf8")));
    assert.deepEqual(
      callers.map((file) => relative(ROOT, file).split("\\").join("/")),
      [],
      "HLS-7 is what may call the clear-HLS planner from production code; until then nothing may",
    );

    // And no production module may read the shadow map for a decision.
    const readers = productionSourceFiles().filter((file) =>
      readFileSync(file, "utf8").includes("analysis.hlsSelections"),
    );
    assert.deepEqual(readers, [], "the normal planner must not consume hlsSelections until HLS-7");
  });
});
