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
import {
  GENERIC_SOURCE_PROTOCOLS,
  GenericPresetSourceSchema,
  type GenericSourceSelections,
} from "./generic-source.ts";
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
 * HLS-6 + HLS-7: the clear-HLS EXECUTION PLAN — representation, derivation,
 * and (since HLS-7) the one point where the ordinary Product planner reaches it.
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
// F. HLS-7 ACTIVATION: the ordinary planner reads ONE owner (§17)
// ─────────────────────────────────────────────────────────────────────────────

type PresetShape = {
  id: string;
  container: string;
  hasVideo: boolean;
  hasAudio?: boolean;
  videoCodec?: string | null;
  audioCodec?: string | null;
};

function genericMeta(presets: PresetShape[]): WorkerVideoMetadata {
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
      videoCodec: p.videoCodec === undefined ? (p.hasVideo ? "h264" : null) : p.videoCodec,
      audioCodec: p.audioCodec === undefined ? "aac" : p.audioCodec,
      fps: null,
    })),
    capabilities: { mp3: true, merge: false },
  });
}

/** A progressive preset: proven audio NAMES the codec that proved it. */
const progressive = (id: string): PresetShape => ({ id, container: "mp4", hasVideo: true });

/** A clear-HLS preset: exactly the HLS-7 public facts, codecs unknown. */
const hlsPublic = (id: string): PresetShape => ({
  id,
  container: "mp4",
  hasVideo: true,
  hasAudio: true,
  videoCodec: null,
  audioCodec: null,
});

const progressiveSource = GenericPresetSourceSchema.parse({
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
});

const progressiveSelections: GenericSourceSelections = { "preset:1080": progressiveSource };

const operationOf = (plan: ReturnType<typeof deriveExecutionPlan>) =>
  plan.strategy === "yt-dlp" ? plan.generic.operation : null;

describe("HLS-7 activation: ordinary derivation reaches clear HLS for an HLS-owned preset", () => {
  it("A: an HLS-ONLY analysis derives clear-hls-remux — nothing injected", () => {
    const analysis = {
      strategy: "yt-dlp" as const,
      video: genericMeta([hlsPublic("preset:best"), hlsPublic("preset:1080")]),
      selections: {},
      hlsSelections: shadow({ "preset:best": selection(), "preset:1080": selection() }),
    };
    for (const id of ["preset:best", "preset:1080"] as const) {
      const plan = deriveExecutionPlan(analysis, id);
      assert.deepEqual(plan, {
        strategy: "yt-dlp",
        generic: {
          strategy: "yt-dlp",
          operation: "clear-hls-remux",
          requestedFormatId: id,
          source: { playlistUrl: PLAYLIST_URL, height: 1080 },
          targetContainer: "mp4",
        },
      });
      // The SAME plan the reviewed HLS-6 derivation builds, frozen as it was.
      assert.deepEqual(plan.strategy === "yt-dlp" ? plan.generic : null, deriveClearHlsExecutionPlan(analysis.hlsSelections, id));
      assert.ok(plan.strategy === "yt-dlp" && Object.isFrozen(plan.generic));
      assert.equal(executionPlanRequiresProcessing(plan), true);
      assert.equal(executionPlanTargetContainer(plan), "mp4");
    }
  });

  it("MIXED: each preset is derived from the ONE family that owns it", () => {
    const analysis = {
      strategy: "yt-dlp" as const,
      video: genericMeta([hlsPublic("preset:best"), hlsPublic("preset:2160"), progressive("preset:1080")]),
      selections: progressiveSelections,
      hlsSelections: shadow({
        "preset:best": selection("https://media.example.invalid/hls/2160.m3u8", 2160),
        "preset:2160": selection("https://media.example.invalid/hls/2160.m3u8", 2160),
      }),
    };
    const progressivePlan = deriveExecutionPlan(analysis, "preset:1080");
    assert.equal(operationOf(progressivePlan), "keep-original");
    assert.equal(JSON.stringify(progressivePlan).includes("m3u8"), false, "no HLS provenance in it");
    assert.equal(operationOf(deriveExecutionPlan(analysis, "preset:best")), "clear-hls-remux");
    assert.equal(operationOf(deriveExecutionPlan(analysis, "preset:2160")), "clear-hls-remux");
  });

  // ── G. No hidden fallback — progressive ownership ──────────────────────────
  it("G: a progressive preset whose progressive owner is gone does NOT fall back to HLS", () => {
    // The advertised preset is progressive: it names its codecs. Its progressive
    // selection is gone — the exact shape a mid-flight site change produces —
    // and an HLS entry for the same id is sitting right there.
    const analysis = {
      strategy: "yt-dlp" as const,
      video: genericMeta([progressive("preset:1080")]),
      selections: {},
      hlsSelections: shadow({ "preset:1080": selection() }),
    };
    assert.equal(
      operationOf({ strategy: "yt-dlp", generic: deriveClearHlsExecutionPlan(analysis.hlsSelections, "preset:1080") }),
      "clear-hls-remux",
      "the HLS entry would genuinely produce a plan",
    );
    expectFormatUnavailable(() => deriveExecutionPlan(analysis, "preset:1080"), "no HLS fallback");

    // The final-analysis shape of the same story: progressive won the rung, so
    // the HLS map never held it. Neither map owns it now.
    expectFormatUnavailable(
      () => deriveExecutionPlan({ ...analysis, hlsSelections: shadow({}) }, "preset:1080"),
      "no owner at all",
    );
  });

  // ── H. No hidden fallback — HLS ownership ──────────────────────────────────
  it("H: an HLS preset whose HLS owner is gone does NOT fall back to progressive", () => {
    // The advertised preset is clear-HLS shaped. Its HLS selection is gone, and
    // a perfectly valid progressive source is available for the same id.
    const sameId = {
      strategy: "yt-dlp" as const,
      video: genericMeta([hlsPublic("preset:1080")]),
      selections: progressiveSelections,
      hlsSelections: shadow({}),
    };
    expectFormatUnavailable(() => deriveExecutionPlan(sameId, "preset:1080"), "no progressive fallback");

    // …and with progressive sources only at OTHER rungs: still no substitution.
    const otherRungs = {
      strategy: "yt-dlp" as const,
      video: genericMeta([hlsPublic("preset:2160"), progressive("preset:1080")]),
      selections: progressiveSelections,
      hlsSelections: shadow({}),
    };
    expectFormatUnavailable(() => deriveExecutionPlan(otherRungs, "preset:2160"), "no other rung");
    assert.equal(operationOf(deriveExecutionPlan(otherRungs, "preset:1080")), "keep-original");
  });

  it("H: an HLS preset whose HLS selection is malformed is refused, not substituted", () => {
    for (const [label, value] of [
      ["unfrozen", { playlistUrl: PLAYLIST_URL, height: 1080 }],
      ["a bad URL", Object.freeze({ playlistUrl: "ftp://media.example.invalid/m.m3u8", height: 1080 })],
    ] as const) {
      const analysis = {
        strategy: "yt-dlp" as const,
        video: genericMeta([hlsPublic("preset:2160"), progressive("preset:1080")]),
        selections: progressiveSelections,
        hlsSelections: { "preset:2160": value as ClearHlsMediaPlaylistSelection },
      };
      expectFormatUnavailable(() => deriveExecutionPlan(analysis, "preset:2160"), label);
    }
  });

  // ── I. Ambiguous dual ownership ────────────────────────────────────────────
  it("I: BOTH maps claiming one id is refused, whichever family the preset looks like", () => {
    for (const shape of [progressive("preset:1080"), hlsPublic("preset:1080")]) {
      const analysis = {
        strategy: "yt-dlp" as const,
        video: genericMeta([shape]),
        selections: progressiveSelections,
        hlsSelections: shadow({ "preset:1080": selection() }),
      };
      expectFormatUnavailable(() => deriveExecutionPlan(analysis, "preset:1080"), JSON.stringify(shape));
    }
  });

  it("I: an INHERITED or accessor claim still counts, and no accessor is invoked", () => {
    // Any statement a map makes about the id is a claim for the ambiguity rule.
    const inherited = Object.create({ "preset:1080": selection() }) as ClearHlsMediaPlaylistSelections;
    expectFormatUnavailable(
      () =>
        deriveExecutionPlan(
          {
            strategy: "yt-dlp",
            video: genericMeta([progressive("preset:1080")]),
            selections: progressiveSelections,
            hlsSelections: inherited,
          },
          "preset:1080",
        ),
      "an inherited HLS claim beside a progressive one",
    );

    let reads = 0;
    const accessor = Object.defineProperty({}, "preset:1080", {
      enumerable: true,
      get() {
        reads += 1;
        return selection();
      },
    }) as ClearHlsMediaPlaylistSelections;
    expectFormatUnavailable(
      () =>
        deriveExecutionPlan(
          {
            strategy: "yt-dlp",
            video: genericMeta([hlsPublic("preset:1080")]),
            selections: {},
            hlsSelections: accessor,
          },
          "preset:1080",
        ),
      "an accessor HLS entry",
    );
    assert.equal(reads, 0, "ownership is read without running a getter");
  });

  // ── Advertising is still required ─────────────────────────────────────────
  it("refuses an HLS-owned rung that the fresh analysis does not advertise", () => {
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

  it("refuses an advertised preset whose formatId is not its id", () => {
    const video = genericMeta([hlsPublic("preset:1080")]);
    const tampered = VideoMetadataSchema.parse({
      ...video,
      presets: video.presets.map((p) => ({ ...p, formatId: "preset:720" })),
    });
    expectFormatUnavailable(
      () =>
        deriveExecutionPlan(
          { strategy: "yt-dlp", video: tampered, selections: {}, hlsSelections: shadow({ "preset:1080": selection() }) },
          "preset:1080",
        ),
      "formatId mismatch",
    );
  });

  // ── K. Audio products ──────────────────────────────────────────────────────
  it("K: clear HLS can never fulfil preset:audio, preset:mp3 or direct-original", () => {
    for (const id of ["preset:audio", "preset:mp3", "direct-original"] as const) {
      const analysis = {
        strategy: "yt-dlp" as const,
        // Advertised, in whatever shape the malformed analysis claims.
        video: genericMeta([
          id === "direct-original" ? hlsPublic("preset:1080") : { id, container: "m4a", hasVideo: false },
        ]),
        selections: {},
        hlsSelections: { [id]: selection() } as ClearHlsMediaPlaylistSelections,
      };
      expectFormatUnavailable(() => deriveExecutionPlan(analysis, id), id);
    }
  });

  // ── J. The direct path ────────────────────────────────────────────────────
  it("J: is unaffected by HLS-shaped private data on the DIRECT path", () => {
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
      hlsSelections: shadow({ "preset:1080": selection(), "direct-original": selection() }),
    };
    const plan = deriveExecutionPlan(analysis, "direct-original");
    assert.equal(plan.strategy, "direct");
    assert.equal(JSON.stringify(plan).includes(VERY_PRIVATE_HLS_TOKEN), false);
    expectFormatUnavailable(() => deriveExecutionPlan(analysis, "preset:1080"), "direct has no HLS arm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. STRUCTURAL BOUNDARIES (§25) AND THE HLS-7 ACTIVATION POINT (§27)
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

describe("HLS-7 structure: activated at ONE point, and nowhere else", () => {
  it("leaves both protocol policies exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("keeps the public withheld vocabulary unchanged — segmented DASH still lands on unsupported_protocol", () => {
    assert.ok((SOURCE_QUALITY_WITHHELD_REASONS as readonly string[]).includes("unsupported_protocol"));
    for (const reason of SOURCE_QUALITY_WITHHELD_REASONS) {
      assert.equal(/hls|m3u8|playlist/i.test(reason), false, `${reason}: no HLS-specific reason`);
    }
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
   * THE HLS-7 STRUCTURAL BOUNDARY — the former HLS-6 §44 activation barrier.
   *
   * HLS-6 pinned "no production module calls `deriveClearHlsExecutionPlan()` or
   * reads `analysis.hlsSelections`", and was designed to fail when HLS-7 landed.
   * HLS-7 is that reviewed edit. What it pins now is the SHAPE of activation:
   * exactly one production call site, inside the ordinary planner; exactly one
   * reader of the fresh analysis's HLS map; the executor reaching HLS only
   * through that planner by default; and no other production module holding
   * HLS private provenance at all.
   */
  it("activates clear HLS in deriveExecutionPlan and NOWHERE else", () => {
    const rel = (file: string) => relative(ROOT, file).split("\\").join("/");
    const code = (file: string) =>
      readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const planner = read("src/worker/execution/format-plan.ts");

    // The machinery exists…
    assert.ok(planner.includes("export function deriveClearHlsExecutionPlan"));
    assert.ok(planner.includes('operation: z.literal("clear-hls-remux")'));

    // …and exactly ONE production call site names it — inside the ordinary
    // planner. A declaration is not a call: it is preceded by `function`.
    // Deliberately NOT a global regex: `.test()` on one would carry `lastIndex`
    // from file to file and silently skip matches.
    const CALL = /(?<!function\s)\bderiveClearHlsExecutionPlan\s*\(/;
    const callers = productionSourceFiles().filter((file) => CALL.test(code(file)));
    assert.deepEqual(callers.map(rel), ["src/worker/execution/format-plan.ts"]);
    const plannerCode = code(join(ROOT, "src/worker/execution/format-plan.ts"));
    assert.equal([...plannerCode.matchAll(new RegExp(CALL.source, "g"))].length, 1, "one call site");
    // `deriveExecutionPlan` is the module's last function, so a call site after
    // its signature is inside it.
    const start = plannerCode.indexOf("export function deriveExecutionPlan(");
    assert.ok(start !== -1 && plannerCode.search(CALL) > start, "the call site is inside deriveExecutionPlan");
    assert.equal(plannerCode.slice(start + 1).includes("export function"), false, "…and it is the last one");

    // Exactly ONE reader of the fresh analysis's HLS map for a decision.
    const readers = productionSourceFiles().filter((file) => code(file).includes("analysis.hlsSelections"));
    assert.deepEqual(readers.map(rel), ["src/worker/execution/format-plan.ts"]);

    // No unrelated production module holds HLS private provenance at all: the
    // map is produced by analysis, carried by the router, stated empty by the
    // executor's direct adapter, and consumed by the planner.
    const holders = productionSourceFiles()
      .filter((file) => !rel(file).startsWith("src/worker/hls/"))
      .filter((file) => code(file).includes("hlsSelections"));
    assert.deepEqual(holders.map(rel).sort(), [
      "src/worker/analysis/media-analyzer.server.ts",
      "src/worker/analysis/ytdlp-analysis.server.ts",
      "src/worker/execution/format-plan.ts",
      "src/worker/execution/job-executor.server.ts",
    ]);
    const executor = code(join(ROOT, "src/worker/execution/job-executor.server.ts"));
    assert.equal([...executor.matchAll(/hlsSelections/g)].length, 1, "the executor only states it empty");
    assert.ok(executor.includes("hlsSelections: {}"));
    const urlHolders = productionSourceFiles()
      .filter((file) => !rel(file).startsWith("src/worker/hls/"))
      .filter((file) => code(file).includes("playlistUrl"));
    assert.deepEqual(urlHolders.map(rel).sort(), [
      "src/worker/analysis/ytdlp-analysis.server.ts",
      "src/worker/execution/format-plan.ts",
    ]);

    // The JobExecutor reaches HLS through the ORDINARY planner by default.
    assert.ok(executor.includes("deps.derivePlanForExecution ?? deriveExecutionPlan"));
  });
});
