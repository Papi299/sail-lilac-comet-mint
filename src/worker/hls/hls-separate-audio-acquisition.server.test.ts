import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { config } from "@/lib/config";
import { setSafeHttpTestHooks } from "@/lib/security/safe-http.server.ts";
import {
  ClearHlsAcquisitionError,
  FMP4_AGGREGATE_FILE_NAME,
  SEPARATE_AUDIO_FMP4_FILE_NAME,
  SEPARATE_VIDEO_FMP4_FILE_NAME,
  acquireClearHlsFmp4,
  acquireClearHlsSeparateAudioFmp4,
  acquireClearHlsSeparateVideoFmp4,
  hlsV1EffectiveAggregateLimitBytes,
} from "./hls-fragment-acquisition.server.ts";
import type { ClearHlsFmp4AcquisitionPlan, ClearHlsMpegTsAcquisitionPlan } from "./hls-preflight.server.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: HLS-3's two separate-audio
 * entry points, and the aggregate allowance that keeps ONE combined byte
 * counter across a pair. The muxed fMP4 path is checked alongside, unchanged.
 */

const BASE = "https://media.example.com/hls/";
const INIT = `${BASE}init.mp4`;
const FRAGMENTS = [`${BASE}seg-0.m4s`, `${BASE}seg-1.m4s`];
const INIT_BYTES = Buffer.alloc(30, 0x49);
const FRAGMENT_BYTES = [Buffer.alloc(40, 0x41), Buffer.alloc(50, 0x42)];
const TOTAL = INIT_BYTES.length + FRAGMENT_BYTES[0]!.length + FRAGMENT_BYTES[1]!.length;

let workDir = "";
let requests: string[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hls-separate-acq-"));
  requests = [];
  const routes = new Map<string, Buffer>([
    [INIT, INIT_BYTES],
    [FRAGMENTS[0]!, FRAGMENT_BYTES[0]!],
    [FRAGMENTS[1]!, FRAGMENT_BYTES[1]!],
  ]);
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async (args) => {
      requests.push(args.url.href);
      const bytes = routes.get(args.url.href);
      if (bytes === undefined) return { status: 404, headers: {}, body: null };
      return { status: 200, headers: { "content-length": String(bytes.length) }, body: Readable.from([bytes]) };
    },
  });
});

afterEach(async () => {
  setSafeHttpTestHooks(null);
  await rm(workDir, { recursive: true, force: true });
});

function fmp4Plan(): ClearHlsFmp4AcquisitionPlan {
  return Object.freeze({
    segmentType: "fmp4" as const,
    initializationMap: Object.freeze({ url: INIT }),
    fragments: Object.freeze(FRAGMENTS.map((url) => Object.freeze({ url }))),
    fragmentCount: FRAGMENTS.length,
  });
}

async function refusal(run: Promise<unknown>): Promise<ClearHlsAcquisitionError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof ClearHlsAcquisitionError, String(err));
    return err;
  }
  assert.fail("the acquisition succeeded");
}

describe("separate-audio halves: their own fixed artifact names", () => {
  it("acquires the video half, map first, into hls-video.fmp4", async () => {
    const result = await acquireClearHlsSeparateVideoFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal });
    assert.equal(result.filePath, join(workDir, SEPARATE_VIDEO_FMP4_FILE_NAME));
    assert.equal(result.segmentType, "fmp4");
    assert.equal(result.fileSize, TOTAL);
    assert.deepEqual(requests, [INIT, ...FRAGMENTS]);
    assert.deepEqual(readFileSync(result.filePath), Buffer.concat([INIT_BYTES, ...FRAGMENT_BYTES]));
    assert.deepEqual(readdirSync(workDir), [SEPARATE_VIDEO_FMP4_FILE_NAME]);
  });

  it("acquires the audio half into hls-audio.fmp4, beside an existing video half", async () => {
    await acquireClearHlsSeparateVideoFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal });
    const audio = await acquireClearHlsSeparateAudioFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal });
    assert.equal(audio.filePath, join(workDir, SEPARATE_AUDIO_FMP4_FILE_NAME));
    assert.deepEqual(readdirSync(workDir).sort(), [SEPARATE_AUDIO_FMP4_FILE_NAME, SEPARATE_VIDEO_FMP4_FILE_NAME]);
  });

  it("uses three distinct names, so no half can pass for another or for a muxed rendition", () => {
    assert.equal(new Set([SEPARATE_VIDEO_FMP4_FILE_NAME, SEPARATE_AUDIO_FMP4_FILE_NAME, FMP4_AGGREGATE_FILE_NAME]).size, 3);
  });

  it("refuses an MPEG-TS plan before any I/O", async () => {
    const ts: ClearHlsMpegTsAcquisitionPlan = Object.freeze({
      segmentType: "mpegts" as const,
      fragments: Object.freeze([Object.freeze({ url: `${BASE}a.ts` })]),
      fragmentCount: 1,
    });
    for (const acquire of [acquireClearHlsSeparateVideoFmp4, acquireClearHlsSeparateAudioFmp4]) {
      const err = await refusal(acquire({ plan: ts as unknown as ClearHlsFmp4AcquisitionPlan, workDir, signal: new AbortController().signal }));
      assert.equal(err.reason, "invalid_plan");
    }
    assert.equal(requests.length, 0);
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("never overwrites an existing half", async () => {
    await acquireClearHlsSeparateVideoFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal });
    requests = [];
    const err = await refusal(acquireClearHlsSeparateVideoFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal }));
    assert.equal(err.reason, "output_error");
    assert.equal(requests.length, 0);
  });
});

describe("the aggregate allowance: it can only narrow", () => {
  it("admits a half of exactly the allowance", async () => {
    const result = await acquireClearHlsSeparateAudioFmp4({
      plan: fmp4Plan(),
      workDir,
      signal: new AbortController().signal,
      maxAggregateBytes: TOTAL,
    });
    assert.equal(result.fileSize, TOTAL);
  });

  it("refuses one byte over the allowance as aggregate_too_large, leaving no artifact", async () => {
    const err = await refusal(
      acquireClearHlsSeparateAudioFmp4({
        plan: fmp4Plan(),
        workDir,
        signal: new AbortController().signal,
        maxAggregateBytes: TOTAL - 1,
      }),
    );
    assert.equal(err.reason, "aggregate_too_large");
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("counts the initialization map against the allowance too", async () => {
    const err = await refusal(
      acquireClearHlsSeparateAudioFmp4({
        plan: fmp4Plan(),
        workDir,
        signal: new AbortController().signal,
        maxAggregateBytes: INIT_BYTES.length - 1,
      }),
    );
    assert.equal(err.reason, "aggregate_too_large");
    assert.deepEqual(requests, [INIT], "refused on the map's declared length, before any fragment");
  });

  it("can never WIDEN the effective Product limit", async () => {
    const saved = config.maxFileSize;
    Object.assign(config, { maxFileSize: TOTAL - 1 });
    try {
      assert.equal(hlsV1EffectiveAggregateLimitBytes(), TOTAL - 1);
      const err = await refusal(
        acquireClearHlsSeparateVideoFmp4({
          plan: fmp4Plan(),
          workDir,
          signal: new AbortController().signal,
          maxAggregateBytes: Number.MAX_SAFE_INTEGER,
        }),
      );
      assert.equal(err.reason, "aggregate_too_large");
    } finally {
      Object.assign(config, { maxFileSize: saved });
    }
  });

  it("refuses a malformed allowance before any I/O", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number]) {
      const err = await refusal(
        acquireClearHlsSeparateAudioFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal, maxAggregateBytes: bad }),
      );
      assert.equal(err.reason, "invalid_plan", String(bad));
    }
    assert.equal(requests.length, 0);
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("leaves the muxed fMP4 path exactly as it was when no allowance is passed", async () => {
    const muxed = await acquireClearHlsFmp4({ plan: fmp4Plan(), workDir, signal: new AbortController().signal });
    assert.equal(muxed.filePath, join(workDir, FMP4_AGGREGATE_FILE_NAME));
    assert.equal(muxed.fileSize, TOTAL);
    assert.equal(existsSync(join(workDir, SEPARATE_VIDEO_FMP4_FILE_NAME)), false);
  });
});
