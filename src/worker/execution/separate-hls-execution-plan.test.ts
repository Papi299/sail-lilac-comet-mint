import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@/lib/errors";
import { VideoMetadataSchema, type WorkerQualityPreset, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { ClearHlsSeparateAudioSelections } from "../hls/hls-separate-audio-selection.ts";
import {
  GenericExecutionPlanSchema,
  deriveClearHlsSeparateAudioExecutionPlan,
  deriveExecutionPlan,
  executionPlanRequiresProcessing,
  snapshotClearHlsSeparateAudioSelection,
  type ClearHlsExecutionPlan,
  type ClearHlsSeparateAudioExecutionPlan,
  type GenericExecutionPlan,
  type GenericSingleSourceExecutionPlan,
  type GenericSplitExecutionPlan,
} from "./format-plan.ts";
import { requiredWorkspaceBytes, workspaceFootprintForPlan } from "./workspace-capacity.ts";
import { downloadGenericOriginal } from "./ytdlp-download.server.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: the planner's side of the
 * separate-audio family — the TOCTOU-safe selection snapshot, the closed plan
 * variant, three-way ownership, the plan partitions and the workspace footprint.
 */

const VIDEO_URL = "https://cdn.example.com/v/1080.m3u8?vtok=PRIVATE_VIDEO_TOKEN";
const AUDIO_URL = "https://cdn.example.com/a/main.m3u8?atok=PRIVATE_AUDIO_TOKEN";

function selection(overrides: Partial<{ videoPlaylistUrl: string; audioPlaylistUrl: string; height: number | null }> = {}) {
  return Object.freeze({ videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080, ...overrides });
}

function hlsPreset(id: string): WorkerQualityPreset {
  return {
    id,
    label: id,
    resolution: "1080p",
    container: "mp4",
    fileSize: null,
    hasVideo: true,
    hasAudio: true,
    formatId: id,
    videoCodec: null,
    audioCodec: null,
    fps: null,
  };
}

function meta(presets: WorkerQualityPreset[]): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Separate audio",
    thumbnail: null,
    duration: 6,
    source: "example.com",
    extractor: "yt-dlp",
    webpageUrl: "https://example.com/watch",
    formats: [],
    presets,
    capabilities: { mp3: false, merge: false },
  });
}

function analysis(separate: ClearHlsSeparateAudioSelections, presets = [hlsPreset("preset:1080")]) {
  return {
    strategy: "yt-dlp" as const,
    video: meta(presets),
    selections: {},
    hlsSelections: {},
    separateHlsSelections: separate,
  };
}

function refusedWith(run: () => unknown, code = "FORMAT_UNAVAILABLE") {
  assert.throws(run, (err: unknown) => err instanceof AppError && err.code === code);
}

describe("separate-audio selection snapshot (TOCTOU discipline)", () => {
  it("captures exactly three validated fields into a frozen object of its own", () => {
    const input = selection();
    const snapshot = snapshotClearHlsSeparateAudioSelection(input);
    assert.deepEqual(snapshot, { videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080 });
    assert.notEqual(snapshot, input);
    assert.ok(Object.isFrozen(snapshot));
    assert.deepEqual(snapshotClearHlsSeparateAudioSelection(selection({ height: null })), {
      videoPlaylistUrl: VIDEO_URL,
      audioPlaylistUrl: AUDIO_URL,
      height: null,
    });
  });

  it("refuses every shape it did not build", () => {
    let reads = 0;
    const accessor = Object.freeze(
      Object.defineProperty({ audioPlaylistUrl: AUDIO_URL, height: 1080 }, "videoPlaylistUrl", {
        get: () => {
          reads += 1;
          return VIDEO_URL;
        },
        enumerable: true,
      }),
    );
    const inherited = Object.freeze(Object.assign(Object.create({ videoPlaylistUrl: VIDEO_URL }), { audioPlaylistUrl: AUDIO_URL, height: 1080 }));
    const nullProto = Object.freeze(Object.assign(Object.create(null), selection()));
    const symbolExtra = Object.freeze({ ...selection(), [Symbol("x")]: 1 });
    const hiddenExtra = Object.freeze(Object.defineProperty({ ...selection() }, "extra", { value: 1, enumerable: false }));
    for (const value of [
      null,
      "x",
      { ...selection() },
      accessor,
      inherited,
      nullProto,
      symbolExtra,
      hiddenExtra,
      Object.freeze({ videoPlaylistUrl: VIDEO_URL, height: 1080 }),
      Object.freeze({ ...selection(), playlistUrl: VIDEO_URL }),
    ]) {
      assert.equal(snapshotClearHlsSeparateAudioSelection(value), null);
    }
    assert.equal(reads, 0, "a hostile getter is never invoked");
  });

  it("requires two accepted, canonical and DIFFERENT playlist URLs and a bounded height", () => {
    for (const overrides of [
      { audioPlaylistUrl: VIDEO_URL },
      { videoPlaylistUrl: "" },
      { videoPlaylistUrl: "/relative.m3u8" },
      { audioPlaylistUrl: "https://10.0.0.1/a.m3u8" },
      { audioPlaylistUrl: "https://user:pw@cdn.example.com/a.m3u8" },
      { videoPlaylistUrl: "HTTPS://CDN.example.com/v.m3u8" },
      { audioPlaylistUrl: ` ${AUDIO_URL}` },
      { height: 0 },
      { height: 1.5 },
      { height: 20_000 },
      { height: "1080" as unknown as number },
    ]) {
      assert.equal(snapshotClearHlsSeparateAudioSelection(selection(overrides)), null, JSON.stringify(overrides));
    }
  });
});

describe("separate-audio plan derivation", () => {
  it("derives the closed, frozen MP4 plan carrying only the two proven URLs and the height", () => {
    const plan = deriveClearHlsSeparateAudioExecutionPlan(Object.freeze({ "preset:1080": selection() }), "preset:1080");
    assert.deepEqual(plan, {
      strategy: "yt-dlp",
      operation: "clear-hls-separate-audio-remux",
      requestedFormatId: "preset:1080",
      source: { videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080 },
      targetContainer: "mp4",
    });
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.source));
    assert.deepEqual(Object.keys(plan.source), ["videoPlaylistUrl", "audioPlaylistUrl", "height"]);
  });

  it("refuses a missing, inherited, accessor-backed or non-video key, with no substitution", () => {
    const map = Object.freeze({ "preset:1080": selection() });
    refusedWith(() => deriveClearHlsSeparateAudioExecutionPlan(map, "preset:720"));
    refusedWith(() => deriveClearHlsSeparateAudioExecutionPlan(map, "preset:audio"));
    refusedWith(() => deriveClearHlsSeparateAudioExecutionPlan(map, "direct-original"));
    refusedWith(() => deriveClearHlsSeparateAudioExecutionPlan(Object.create(map), "preset:1080"));
    const getter = Object.freeze(Object.defineProperty({}, "preset:1080", { get: () => selection(), enumerable: true }));
    refusedWith(() => deriveClearHlsSeparateAudioExecutionPlan(getter as ClearHlsSeparateAudioSelections, "preset:1080"));
    refusedWith(() => deriveClearHlsSeparateAudioExecutionPlan(null as unknown as ClearHlsSeparateAudioSelections, "preset:1080"));
  });

  it("puts no URL or token in any refusal", () => {
    try {
      deriveClearHlsSeparateAudioExecutionPlan(Object.freeze({ "preset:1080": selection({ audioPlaylistUrl: VIDEO_URL }) }), "preset:1080");
      assert.fail("derived");
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack}`;
      assert.equal(text.includes("PRIVATE_VIDEO_TOKEN") || text.includes("cdn.example.com"), false);
    }
  });

  it("is represented by the schema only in its closed form", () => {
    const valid = {
      strategy: "yt-dlp",
      operation: "clear-hls-separate-audio-remux",
      requestedFormatId: "preset:1080",
      source: { videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080 },
      targetContainer: "mp4",
    };
    assert.equal(GenericExecutionPlanSchema.safeParse(valid).success, true);
    for (const forged of [
      { ...valid, extra: 1 },
      { ...valid, source: { ...valid.source, masterUrl: "https://cdn.example.com/master.m3u8" } },
      { ...valid, source: { ...valid.source, audioPlaylistUrl: VIDEO_URL } },
      { ...valid, targetContainer: "webm" },
      { ...valid, requestedFormatId: "preset:audio" },
      { ...valid, strategy: "direct" },
    ]) {
      assert.equal(GenericExecutionPlanSchema.safeParse(forged).success, false, JSON.stringify(forged).slice(0, 120));
    }
  });
});

describe("three-way ownership in the ordinary planner", () => {
  it("dispatches a preset the separate-audio map alone owns to the separate-audio derivation", () => {
    const plan = deriveExecutionPlan(analysis(Object.freeze({ "preset:1080": selection() })), "preset:1080");
    assert.equal(plan.strategy, "yt-dlp");
    assert.equal(plan.strategy === "yt-dlp" ? plan.generic.operation : null, "clear-hls-separate-audio-remux");
    assert.ok(executionPlanRequiresProcessing(plan));
  });

  it("refuses a preset two families claim — never resolving it by precedence", () => {
    const both = {
      ...analysis(Object.freeze({ "preset:1080": selection() })),
      hlsSelections: Object.freeze({ "preset:1080": Object.freeze({ playlistUrl: VIDEO_URL, height: 1080 }) }),
    };
    refusedWith(() => deriveExecutionPlan(both, "preset:1080"));
    const withProgressive = { ...analysis(Object.freeze({ "preset:1080": selection() })), selections: { "preset:1080": {} as never } };
    refusedWith(() => deriveExecutionPlan(withProgressive, "preset:1080"));
  });

  it("refuses when the advertised preset does not state the clear-HLS facts, or is not advertised", () => {
    const wrongFacts = analysis(Object.freeze({ "preset:1080": selection() }), [{ ...hlsPreset("preset:1080"), audioCodec: "aac" }]);
    refusedWith(() => deriveExecutionPlan(wrongFacts, "preset:1080"));
    refusedWith(() => deriveExecutionPlan(analysis(Object.freeze({ "preset:1080": selection() }), []), "preset:1080"));
  });

  it("treats an inherited key as no claim at all", () => {
    refusedWith(() => deriveExecutionPlan(analysis(Object.create(Object.freeze({ "preset:1080": selection() }))), "preset:1080"));
  });

  it("refuses a malformed selection rather than falling back to any other family", () => {
    refusedWith(() =>
      deriveExecutionPlan(analysis(Object.freeze({ "preset:1080": selection({ audioPlaylistUrl: VIDEO_URL }) })), "preset:1080"),
    );
  });
});

// ── Plan partitions (compile-time) ───────────────────────────────────────────

type Disjoint<A, B> = [Extract<A, B>] extends [never] ? true : false;
const singleSourceExcludesIt: Disjoint<GenericSingleSourceExecutionPlan, { operation: "clear-hls-separate-audio-remux" }> = true;
const splitExcludesIt: Disjoint<GenericSplitExecutionPlan, { operation: "clear-hls-separate-audio-remux" }> = true;
const muxedExcludesIt: Disjoint<ClearHlsExecutionPlan, { operation: "clear-hls-separate-audio-remux" }> = true;
type DownloaderPlan = Parameters<typeof downloadGenericOriginal>[2];
const downloaderCannotTakeIt: ClearHlsSeparateAudioExecutionPlan extends DownloaderPlan ? true : false = false;
type Covered = Exclude<
  GenericExecutionPlan,
  GenericSingleSourceExecutionPlan | GenericSplitExecutionPlan | ClearHlsExecutionPlan | ClearHlsSeparateAudioExecutionPlan
>;
const fourPartitionsCoverTheUnion: [Covered] extends [never] ? true : false = true;

describe("plan partitions", () => {
  it("keep the new operation out of every other acquisition seam, and together cover the union", () => {
    assert.deepEqual(
      [singleSourceExcludesIt, splitExcludesIt, muxedExcludesIt, downloaderCannotTakeIt, fourPartitionsCoverTheUnion],
      [true, true, true, false, true],
    );
  });
});

describe("the single-source yt-dlp downloader refuses the operation at run time", () => {
  let workDir = "";
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "separate-hls-plan-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("before URL validation, the runtime probe or any subprocess", async () => {
    const plan = deriveClearHlsSeparateAudioExecutionPlan(Object.freeze({ "preset:1080": selection() }), "preset:1080");
    let validated = 0;
    let probed = 0;
    let spawned = 0;
    let thrown: unknown;
    try {
      await downloadGenericOriginal("https://example.com/watch", workDir, plan as unknown as GenericSingleSourceExecutionPlan, {
        limits: { maxFileSizeBytes: 1024, downloadTimeoutSeconds: 10 },
        validateUrl: async (raw: string) => {
          validated += 1;
          return { url: raw, hostname: "example.com" };
        },
        probeRuntime: async () => {
          probed += 1;
          return { available: true, version: "2026.08.19", reason: "ok" as const };
        },
        runner: async () => {
          spawned += 1;
          throw new Error("spawned");
        },
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof AppError && thrown.code === "FORMAT_UNAVAILABLE");
    assert.deepEqual([validated, probed, spawned], [0, 0, 0]);
    assert.deepEqual(readdirSync(workDir), []);
    const text = `${(thrown as Error).message} ${(thrown as Error).stack}`;
    assert.equal(text.includes("PRIVATE_") || text.includes("m3u8"), false);
  });
});

describe("workspace footprint of the two-input shape", () => {
  const plan = { strategy: "yt-dlp" as const, generic: { operation: "clear-hls-separate-audio-remux" as const } };

  it("is 2 × maxFileSize: both halves (<= max together) plus the merged MP4 (<= max)", () => {
    assert.equal(workspaceFootprintForPlan(plan), 2);
    const max = 4 * 1024 ** 3;
    assert.equal(requiredWorkspaceBytes(max, workspaceFootprintForPlan(plan)), 2 * max);
  });

  it("matches merge-split, the other two-input shape, and never undercounts it as one input", () => {
    assert.equal(
      workspaceFootprintForPlan(plan),
      workspaceFootprintForPlan({ strategy: "yt-dlp", generic: { operation: "merge-split" } }),
    );
    assert.ok(workspaceFootprintForPlan(plan) > workspaceFootprintForPlan({ strategy: "yt-dlp", generic: { operation: "keep-original" } }));
  });
});
