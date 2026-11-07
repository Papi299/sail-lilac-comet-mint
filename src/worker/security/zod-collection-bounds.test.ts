/**
 * Every application array is rejected on its size before any element is read.
 *
 * The four arrays with no bound built one validation issue per bad element, so a hostile document's cost grew
 * with its length up to the byte ceiling. Each test here tells three outcomes apart:
 *   - rejected on the bound: refused, and `elementReads` proves no element was visited;
 *   - walked element by element: an oversized list that is refused only after reading its elements fails here;
 *   - rejected too early: a list at the limit, built from real producer output, must still be accepted.
 *
 * `elementReads` counts through a Proxy rather than a timer or a heap reading, so every size stays small and fixed.
 * Parsers that take a string get the counting document through a stubbed `JSON.parse`, the only way to hand them
 * one. The positive controls in each block prove the counter does see a walk, so a zero means something.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, mock } from "node:test";
import { z } from "zod";

import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { setSafeHttpTestHooks } from "@/lib/security/safe-http.server.ts";
import { buildPresets } from "@/services/extractors/normalize";
import { parseProbeDocument, parseTimedProbeDocument } from "@/services/processing/ffprobe.server";
import { setProcessRunnerTestHooks } from "@/services/processing/process-runner.server.ts";
import {
  VIDEO_METADATA_MAX_FORMATS,
  VIDEO_METADATA_MAX_PRESETS,
  VideoMetadataSchema,
  WORKER_REQUESTED_FORMAT_IDS,
  WorkerAnalyzeSuccessSchema,
  type WorkerNormalizedFormat,
  type WorkerQualityPreset,
} from "@/shared/worker/contracts";
import { WorkerClient } from "@/web/worker/worker-client.server";
import {
  GENERIC_PRESET_ID_PATTERN,
  YTDLP_ANALYSIS_MAX_PRESETS,
  YTDLP_ANALYSIS_MAX_RAW_FORMATS,
  YTDLP_REJECTED_LIVE_STATUSES,
  analyzeGenericMedia,
  parseAnalysisInfo,
} from "@/worker/analysis/ytdlp-analysis.server";
import { analyzeDirectMedia } from "@/worker/execution/direct-media.server";

const MAX_PROBE_STREAMS = 16;
/** Far past every limit, and small enough to be free. */
const OVERSIZED = 10_000;
const SENTINEL = "SENTINEL_UPSTREAM_TITLE";

/** An array that counts how many of its elements anything reads. */
function counting(elements: readonly unknown[]) {
  const count = { reads: 0 };
  const list = new Proxy([...elements], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) count.reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, count };
}

/** Runs a string-taking parser against a document that holds a counting array. */
function parsingDocument<T>(document: unknown, parse: () => T): T {
  const stub = mock.method(JSON, "parse", () => document);
  try {
    return parse();
  } finally {
    stub.mock.restore();
  }
}

const repeat = <T>(length: number, element: T): T[] => new Array<T>(length).fill(element);

// ── The shapes every oversized list is tried with ────────────────────────────

/** Valid, junk, and valid with one bad element in the last place a walk would reach. */
function oversizedVariants<T>(length: number, valid: T): ReadonlyArray<readonly [string, readonly unknown[]]> {
  const mixed: unknown[] = repeat(length, valid);
  mixed[length - 1] = 0;
  return [
    ["valid elements", repeat(length, valid)],
    ["junk elements", repeat(length, 0)],
    ["valid elements and one bad one", mixed],
  ];
}

const RAW_FORMAT = { format_id: "f", ext: "mp4", protocol: "https", vcodec: "avc1", acodec: "mp4a", height: 720 };
const STREAM = { codec_type: "audio" };
const FORMAT: WorkerNormalizedFormat = {
  id: "direct-original",
  resolution: "720p",
  width: 1280,
  height: 720,
  fps: 30,
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  bitrate: null,
  fileSize: 1024,
  hasVideo: true,
  hasAudio: true,
};
const preset = (id: string): WorkerQualityPreset => ({
  id,
  label: id,
  resolution: null,
  container: "mp4",
  fileSize: null,
  hasVideo: true,
  hasAudio: true,
  formatId: id,
  videoCodec: null,
  audioCodec: null,
  fps: null,
});
const PRESET_IDS = WORKER_REQUESTED_FORMAT_IDS.filter((id) => id.startsWith("preset:"));

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    title: "t",
    thumbnail: null,
    duration: null,
    source: "example.invalid",
    extractor: "direct",
    webpageUrl: "https://example.invalid/clip.mp4",
    formats: [],
    presets: [],
    capabilities: { mp3: false, merge: false },
    ...overrides,
  };
}

describe("instrument: an unbounded array is walked, a bounded one is not", () => {
  it("sees every element of an unbounded array, one issue each", () => {
    const { list, count } = counting(repeat(1_000, 0));
    const parsed = z.array(z.string()).safeParse(list);
    assert.equal(parsed.error?.issues.length, 1_000);
    assert.equal(count.reads, 1_000);
  });

  it("sees no element of the same array behind a leading bound, and one issue", () => {
    const { list, count } = counting(repeat(1_000, 0));
    const parsed = z.array(z.string()).max(10).safeParse(list);
    assert.equal(parsed.error?.issues.length, 1);
    assert.equal(count.reads, 0);
  });
});

// ── D1: raw yt-dlp formats ───────────────────────────────────────────────────

describe("RawInfoSchema.formats", () => {
  const LIMIT = YTDLP_ANALYSIS_MAX_RAW_FORMATS;
  const document = (formats: unknown, overrides: Record<string, unknown> = {}) => ({ _type: "video", formats, ...overrides });
  const rejectionOf = (doc: unknown) => {
    const parsed = parseAnalysisInfo(JSON.stringify(doc));
    return parsed.ok ? "accepted" : parsed.rejection;
  };

  it("keeps the published limit: the other tests read this constant, so only this one would see it move", () => {
    assert.equal(YTDLP_ANALYSIS_MAX_RAW_FORMATS, 512);
  });

  it("accepts exactly the limit, in order, with nothing dropped", () => {
    const formats = Array.from({ length: LIMIT }, (_, i) => ({ ...RAW_FORMAT, format_id: `f${i}` }));
    const parsed = parseAnalysisInfo(JSON.stringify(document(formats)));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.info.formats?.map((f) => f.format_id), formats.map((f) => f.format_id));
  });

  it("keeps a missing, null or empty list valid", () => {
    assert.equal(rejectionOf({ _type: "video" }), "accepted");
    assert.equal(rejectionOf(document(null)), "accepted");
    assert.equal(rejectionOf(document([])), "accepted");
  });

  for (const length of [LIMIT + 1, OVERSIZED]) {
    for (const [name, elements] of oversizedVariants(length, RAW_FORMAT)) {
      it(`refuses ${length} formats, ${name}, without reading one`, () => {
        const { list, count } = counting(elements);
        const parsed = parsingDocument(document(list), () => parseAnalysisInfo("{}"));
        assert.deepEqual(parsed, { ok: false, rejection: "too_many_formats" });
        assert.equal(count.reads, 0);
      });
    }
  }

  it("walks a list within the limit, so a bad element there is still invalid_shape", () => {
    const { list, count } = counting(repeat(LIMIT, 0));
    const parsed = parsingDocument(document(list), () => parseAnalysisInfo("{}"));
    assert.deepEqual(parsed, { ok: false, rejection: "invalid_shape" });
    assert.equal(count.reads, LIMIT);
  });

  it("keeps a non-array list, and a non-object document, invalid_shape", () => {
    assert.equal(rejectionOf(document("many")), "invalid_shape");
    assert.equal(rejectionOf(document({ length: OVERSIZED })), "invalid_shape");
    for (const notAnObject of [[], null, 5, "text", true]) assert.equal(rejectionOf(notAnObject), "invalid_shape");
  });

  it("keeps malformed JSON its own rejection", () => {
    assert.deepEqual(parseAnalysisInfo('{"formats":['), { ok: false, rejection: "malformed_json" });
  });

  // The order the gates are read in is the contract. Each row holds for a list within the limit and for an oversized
  // one, whatever the oversized elements are, except that only an oversized list can reach the last row.
  const GATES: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["a bad top-level field", { title: 42 }, "invalid_shape"],
    ["a bad field beats a playlist", { _type: "playlist", duration: "x" }, "invalid_shape"],
    ["a playlist", { _type: "playlist" }, "not_single_video"],
    ["a multi-part show", { _type: "multi_video" }, "not_single_video"],
    ["no _type", { _type: undefined }, "not_single_video"],
    ["a playlist beats entries and live", { _type: "playlist", entries: [], is_live: true }, "not_single_video"],
    ["entries", { entries: [] }, "multi_entry"],
    ["entries beat live", { entries: [{}], is_live: true }, "multi_entry"],
    ["a live flag", { is_live: true }, "live_source"],
    ...YTDLP_REJECTED_LIVE_STATUSES.map((status) => [`live_status ${status}`, { live_status: status }, "live_source"] as const),
  ];

  for (const [name, overrides, expected] of GATES) {
    it(`gives ${expected} for ${name}, at any list length`, () => {
      assert.equal(rejectionOf(document(repeat(LIMIT, RAW_FORMAT), overrides)), expected, "within the limit");
      for (const [variant, elements] of oversizedVariants(LIMIT + 1, RAW_FORMAT)) {
        assert.equal(rejectionOf(document(elements, overrides)), expected, `oversized, ${variant}`);
      }
    });
  }

  it("treats null entries and an unrejected live_status as absent, reaching the bound", () => {
    for (const overrides of [{ entries: null }, { is_live: false }, { live_status: "not_live" }, { live_status: "was_live" }]) {
      assert.equal(rejectionOf(document(repeat(LIMIT + 1, RAW_FORMAT), overrides)), "too_many_formats");
    }
  });
});

describe("analysis maps an oversized document to the same public codes", () => {
  const runner = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });
  const analyze = (doc: unknown, ffmpegAvailable = false) =>
    analyzeGenericMedia("https://example.invalid/watch", {
      limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 500 * 1024 * 1024 },
      runner: runner(JSON.stringify(doc)),
      probeRuntime: async () => ({ available: true, version: "pinned", reason: "ok" }) as never,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable,
    });
  const oversized = repeat(YTDLP_ANALYSIS_MAX_RAW_FORMATS + 1, RAW_FORMAT);

  for (const [name, overrides, code] of [
    ["too many formats", {}, "EXTRACTION_FAILED"],
    ["a playlist", { _type: "playlist" }, "UNSUPPORTED_SITE"],
    ["entries", { entries: [] }, "UNSUPPORTED_SITE"],
    ["a live source", { is_live: true }, "VIDEO_UNAVAILABLE"],
  ] as const) {
    it(`reports ${code} for ${name}, with no upstream text`, async () => {
      await assert.rejects(analyze({ _type: "video", title: SENTINEL, formats: oversized, ...overrides }), (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, code);
        assert.equal(`${err.message}${JSON.stringify(err)}`.includes(SENTINEL), false);
        return true;
      });
    });
  }
});

// ── D2: ffprobe streams ──────────────────────────────────────────────────────

describe("FfprobeDocumentSchema.streams", () => {
  const format = { format_name: "matroska,webm", start_time: "0.000000" };
  const PARSERS = [
    ["untimed", parseProbeDocument],
    ["timed", parseTimedProbeDocument],
  ] as const;
  const assertProcessingFailed = (run: () => unknown) =>
    assert.throws(run, (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED");

  for (const [name, parse] of PARSERS) {
    it(`${name}: accepts exactly the limit, in order`, () => {
      const kinds = Array.from({ length: MAX_PROBE_STREAMS }, (_, i) => (i % 2 === 0 ? "video" : "audio"));
      const probe = parse(JSON.stringify({ format, streams: kinds.map((codec_type) => ({ codec_type })) }));
      assert.deepEqual(probe.streams, kinds);
    });

    for (const length of [MAX_PROBE_STREAMS + 1, OVERSIZED]) {
      for (const [variant, elements] of oversizedVariants(length, STREAM)) {
        it(`${name}: refuses ${length} streams, ${variant}, without reading one`, () => {
          const { list, count } = counting(elements);
          assertProcessingFailed(() => parsingDocument({ format, streams: list }, () => parse("{}")));
          assert.equal(count.reads, 0);
        });
      }
    }

    it(`${name}: walks a list within the limit, so a bad element there still fails`, () => {
      const { list, count } = counting(repeat(MAX_PROBE_STREAMS, 0));
      assertProcessingFailed(() => parsingDocument({ format, streams: list }, () => parse("{}")));
      assert.equal(count.reads, MAX_PROBE_STREAMS);
    });

    it(`${name}: keeps an empty, missing or null list, and malformed JSON, PROCESSING_FAILED`, () => {
      for (const raw of [{ format, streams: [] }, { format }, { format, streams: null }]) {
        assertProcessingFailed(() => parse(JSON.stringify(raw)));
      }
      assertProcessingFailed(() => parse('{"streams":['));
    });

    it(`${name}: keeps a stream that is neither video nor audio PROCESSING_FAILED`, () => {
      assertProcessingFailed(() => parse(JSON.stringify({ format, streams: [{ codec_type: "subtitle" }] })));
    });

    it(`${name}: keeps an unsupported container PROCESSING_FAILED, at any list length`, () => {
      const unsupported = { format_name: "flv", start_time: "0.000000" };
      assertProcessingFailed(() => parse(JSON.stringify({ format: unsupported, streams: [STREAM] })));
      assertProcessingFailed(() => parse(JSON.stringify({ format: unsupported, streams: repeat(OVERSIZED, STREAM) })));
    });

    for (const kinds of [["video"], ["audio"], ["video", "audio"], ["audio", "video"]]) {
      it(`${name}: still reads a split-media probe of ${kinds.join(" + ")}`, () => {
        const probe = parse(JSON.stringify({ format, streams: kinds.map((codec_type) => ({ codec_type })), programs: [] }));
        assert.deepEqual(probe.streams, kinds);
        assert.equal(probe.family, "webm");
      });
    }
  }

  it("keeps the timed parser's start time", () => {
    const probe = parseTimedProbeDocument(JSON.stringify({ format: { ...format, start_time: "1.500000" }, streams: [STREAM] }));
    assert.equal(probe.startTimeUs, 1_500_000);
  });
});

// ── D3 and D4: Worker video metadata ─────────────────────────────────────────

describe("the metadata bounds come from the requestable vocabulary", () => {
  it("allows the one concrete format and the eleven presets", () => {
    assert.equal(VIDEO_METADATA_MAX_FORMATS, 1);
    assert.equal(VIDEO_METADATA_MAX_PRESETS, 11);
    assert.equal(VIDEO_METADATA_MAX_FORMATS + VIDEO_METADATA_MAX_PRESETS, WORKER_REQUESTED_FORMAT_IDS.length);
  });

  it("gives the generic analyzer the same preset bound and vocabulary", () => {
    assert.equal(YTDLP_ANALYSIS_MAX_PRESETS, VIDEO_METADATA_MAX_PRESETS);
    for (const id of PRESET_IDS) assert.match(id, GENERIC_PRESET_ID_PATTERN);
  });
});

describe("VideoMetadataSchema.formats and .presets", () => {
  const LISTS = [
    ["formats", VIDEO_METADATA_MAX_FORMATS, FORMAT],
    ["presets", VIDEO_METADATA_MAX_PRESETS, preset("preset:best")],
  ] as const;

  for (const [field, limit, valid] of LISTS) {
    it(`${field}: accepts empty and exactly the limit`, () => {
      assert.equal(VideoMetadataSchema.safeParse(metadata({ [field]: [] })).success, true);
      assert.equal(VideoMetadataSchema.safeParse(metadata({ [field]: repeat(limit, valid) })).success, true);
    });

    it(`${field}: keeps a missing or null list invalid`, () => {
      const { [field]: _omitted, ...without } = metadata();
      assert.equal(VideoMetadataSchema.safeParse(without).success, false);
      assert.equal(VideoMetadataSchema.safeParse(metadata({ [field]: null })).success, false);
    });

    for (const length of [limit + 1, OVERSIZED]) {
      for (const [variant, elements] of oversizedVariants(length, valid)) {
        it(`${field}: refuses ${length}, ${variant}, with one issue and no read`, () => {
          const { list, count } = counting(elements);
          const parsed = VideoMetadataSchema.safeParse(metadata({ [field]: list }));
          assert.equal(parsed.success, false);
          assert.equal(parsed.data, undefined, "nothing is returned, so nothing can be truncated");
          assert.equal(parsed.error?.issues.length, 1);
          assert.equal(parsed.error?.issues[0]?.code, "too_big");
          assert.deepEqual(parsed.error?.issues[0]?.path, [field]);
          assert.equal(count.reads, 0);
        });
      }
    }

    it(`${field}: reports an oversized list in a small error that does not hold it`, () => {
      const parsed = VideoMetadataSchema.safeParse(metadata({ [field]: repeat(OVERSIZED, 0) }));
      assert.ok(JSON.stringify(parsed.error?.issues).length < 300);
      assert.equal(Object.hasOwn(parsed.error?.issues[0] ?? {}, "input"), false);
    });

    it(`${field}: walks a list within the limit, one element's issues at a time`, () => {
      const { list, count } = counting(repeat(limit, 0));
      const parsed = VideoMetadataSchema.safeParse(metadata({ [field]: list }));
      assert.equal(parsed.error?.issues.length, limit);
      assert.equal(count.reads, limit);
    });

    it(`${field}: refuses an oversized list through the analyze response too`, () => {
      const { list, count } = counting(repeat(OVERSIZED, 0));
      const parsed = WorkerAnalyzeSuccessSchema.safeParse({ success: true, video: metadata({ [field]: list }) });
      assert.equal(parsed.error?.issues.length, 1);
      assert.deepEqual(parsed.error?.issues[0]?.path, ["video", field]);
      assert.equal(count.reads, 0);
    });
  }

  it("reports both lists when both are oversized, one issue each", () => {
    const parsed = VideoMetadataSchema.safeParse(metadata({ formats: repeat(OVERSIZED, 0), presets: repeat(OVERSIZED, 0) }));
    assert.deepEqual(parsed.error?.issues.map((issue) => issue.path), [["formats"], ["presets"]]);
  });

  it("returns a full preset list unchanged and in order", () => {
    const presets = PRESET_IDS.map(preset);
    const parsed = VideoMetadataSchema.parse(metadata({ formats: [FORMAT], presets }));
    assert.deepEqual(parsed.presets, presets);
    assert.deepEqual(parsed.formats, [FORMAT]);
  });
});

describe("every real producer fits the bounds", () => {
  const ORIGINAL_FFMPEG_PATH = config.ffmpegPath;

  afterEach(() => {
    config.ffmpegPath = ORIGINAL_FFMPEG_PATH;
    setSafeHttpTestHooks(null);
    setProcessRunnerTestHooks(null);
  });

  /** Makes `ffmpegAvailable()` answer true with a fake child, as the direct-analysis suite does, so MP3 is on offer. */
  function installFakeFfmpeg() {
    config.ffmpegPath = process.execPath;
    setProcessRunnerTestHooks({
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
        setImmediate(() => {
          child.stdout.end("ffmpeg version 7.0-test\n");
          child.stderr.end();
        });
        return child as unknown as ChildProcess;
      },
    });
  }

  it("the generic analyzer's fullest ladder passes, whole and in order", async () => {
    const heights = [2160, 1440, 1080, 720, 480, 360, 240, 144];
    const formats = [
      ...heights.map((height) => ({ format_id: `v${height}`, ext: "mp4", protocol: "https", height, vcodec: "avc1.640028", acodec: "none" })),
      { format_id: "a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
    ];
    const video = await analyzeGenericMedia("https://example.invalid/watch", {
      limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 500 * 1024 * 1024 },
      runner: async () => ({ code: 0, stdout: JSON.stringify({ _type: "video", title: "t", formats }), stderr: "" }),
      probeRuntime: async () => ({ available: true, version: "pinned", reason: "ok" }) as never,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: true,
    });
    assert.equal(video.presets.length, VIDEO_METADATA_MAX_PRESETS);
    assert.deepEqual(video.formats, []);
    assert.deepEqual(video.presets.map((p) => p.id), PRESET_IDS);
    assert.deepEqual(WorkerAnalyzeSuccessSchema.parse({ success: true, video }).video, video);
  });

  it("the generic analyzer accepts the raw-format limit through the whole path", async () => {
    const formats = Array.from({ length: YTDLP_ANALYSIS_MAX_RAW_FORMATS }, (_, i) => ({ ...RAW_FORMAT, format_id: `f${i}` }));
    const video = await analyzeGenericMedia("https://example.invalid/watch", {
      limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 500 * 1024 * 1024 },
      runner: async () => ({ code: 0, stdout: JSON.stringify({ _type: "video", title: "t", formats }), stderr: "" }),
      probeRuntime: async () => ({ available: true, version: "pinned", reason: "ok" }) as never,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: false,
    });
    assert.ok(video.presets.length > 0);
    assert.deepEqual(video.formats, []);
  });

  // Every direct shape, with FFmpeg present so the MP3 preset is offered: the largest set direct analysis can publish.
  for (const [url, contentType, expected] of [
    ["https://cdn.example.com/clip.mp4", "video/mp4", ["preset:best", "preset:audio", "preset:mp3"]],
    ["https://cdn.example.com/clip.webm", "video/webm", ["preset:best", "preset:audio", "preset:mp3"]],
    ["https://cdn.example.com/song.mp3", "audio/mpeg", ["preset:audio", "preset:mp3"]],
    ["https://cdn.example.com/song.m4a", "audio/mp4", ["preset:audio", "preset:mp3"]],
  ] as const) {
    it(`direct analysis of ${contentType} passes with its one format and every preset`, async () => {
      installFakeFfmpeg();
      setSafeHttpTestHooks({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        requestOnce: async () => ({ status: 200, headers: { "content-length": "2048", "content-type": contentType }, body: null }),
      });
      const video = await analyzeDirectMedia(url);
      assert.equal(video.extractor, "direct");
      assert.equal(video.formats.length, VIDEO_METADATA_MAX_FORMATS);
      assert.equal(video.formats[0]?.id, "direct-original");
      assert.deepEqual(video.presets.map((p) => p.id), expected);
      assert.deepEqual(WorkerAnalyzeSuccessSchema.parse({ success: true, video }).video, video);
    });
  }

  it("direct analysis still rejects a producer that breaks the contract, with its own code", async () => {
    setSafeHttpTestHooks({ lookup: async () => [{ address: "93.184.216.34", family: 4 }], requestOnce: async () => ({ status: 200, headers: {}, body: null }) });
    await assert.rejects(
      analyzeDirectMedia("https://cdn.example.com/clip.mp4", undefined, async () => metadata({ formats: [FORMAT, FORMAT] })),
      (err: unknown) => err instanceof AppError && err.code === "ANALYSIS_FAILED",
    );
  });

  it("the shared preset builder cannot exceed the bound even from a full legacy format list", () => {
    const formats: WorkerNormalizedFormat[] = [
      ...["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"].map((resolution) => ({ ...FORMAT, id: resolution, resolution })),
      { ...FORMAT, id: "audio", resolution: "audio", hasVideo: false, videoCodec: null, container: "m4a" },
    ];
    const presets = buildPresets(formats, { mp3: true, ffmpeg: true });
    assert.equal(presets.length, VIDEO_METADATA_MAX_PRESETS);
    assert.deepEqual(new Set(presets.map((p) => p.id)), new Set(PRESET_IDS));
  });

});

describe("the control plane reads the Worker's analyze response through the same bounds", () => {
  const client = (body: unknown) =>
    new WorkerClient({
      baseUrl: "http://localhost:8080",
      currentKeyId: "test-key-id",
      currentSecret: "01234567890123456789012345678901",
      fetchImplementation: (async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
  const analyze = (video: unknown) => client({ success: true, video }).analyze({ url: "https://example.com/clip.mp4" });

  it("accepts what the current and every earlier Worker sends: one format, or none and a full ladder", async () => {
    const direct = metadata({ formats: [FORMAT], presets: [preset("preset:best"), preset("preset:mp3")] });
    assert.deepEqual((await analyze(direct)).video, direct);
    const generic = metadata({ extractor: "yt-dlp", presets: PRESET_IDS.map(preset) });
    assert.deepEqual((await analyze(generic)).video, generic);
  });

  for (const [field, list] of [
    ["formats", repeat(VIDEO_METADATA_MAX_FORMATS + 1, FORMAT)],
    ["presets", repeat(VIDEO_METADATA_MAX_PRESETS + 1, preset("preset:best"))],
  ] as const) {
    it(`refuses too many ${field} as the canonical PROCESSING_FAILED`, async () => {
      await assert.rejects(analyze(metadata({ [field]: list })), (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED");
    });
  }
});
