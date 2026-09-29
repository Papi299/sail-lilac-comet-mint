import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { readdir as fsReaddir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AppError } from "../../lib/errors.ts";
import { runProcess, type RunResult } from "../../services/processing/process-runner.server.ts";
import { analyzeGenericMediaInternal } from "../analysis/ytdlp-analysis.server.ts";
import { deriveExecutionPlan, type GenericSplitExecutionPlan } from "../execution/format-plan.ts";
import {
  buildYtdlpDownloadEnvironment,
  buildYtdlpSplitDownloadArgv,
  classifySegmentedAcquisitionEntry,
  downloadGenericSplitSources,
} from "../execution/ytdlp-download.server.ts";
import { YTDLP_RUNTIME, buildYtdlpEnvironment, ytdlpPolicyArgs, type YtdlpRuntimeStatus } from "./ytdlp-runtime.server.ts";

/**
 * GENERIC-SEGMENTED-DASH-EXECUTION-001 — the PINNED-RUNTIME contract.
 *
 * Everything else about segmented DASH is proven against fakes. This file runs
 * the EXACT pinned yt-dlp artifact — its digest is checked against
 * `YTDLP_RUNTIME.sha256` before anything executes — and proves the facts the
 * admission of `http_dash_segments` rests on:
 *
 *   1. under the application's REAL acquisition argv, `http_dash_segments`
 *      selects `DashSegmentsFD` with NO fragment delegate, live or not, and
 *      whether or not FFmpeg is available; `http`/`https` select `HttpFD`;
 *   2. the argv really turns fragment skipping OFF, keeps one fragment in
 *      flight, and keeps no fragments;
 *   3. the Worker's own analysis and acquisition, driven through the pinned
 *      artifact against a local segmented MPD, produce exactly the fragment
 *      grammar the monitor was written for, a byte-exact aggregate, and a clean
 *      job directory — and the guard and failure paths behave as documented.
 *
 * WHERE IT RUNS. Inside the Worker image the artifact is at its pinned path and
 * this file runs with no configuration. Elsewhere it runs only when pointed at a
 * copy by `VIDEOFETCH_PINNED_YTDLP_ARTIFACT` (and an interpreter by
 * `VIDEOFETCH_PINNED_YTDLP_PYTHON`), and ONLY if that copy's digest equals the
 * pin. Otherwise every test SKIPS and says why. The always-on companion is the
 * static pin test in `generic-source.test.ts`, which fails the moment the
 * runtime pin changes, so an upgrade cannot pass without this contract being
 * re-run and reviewed. `verify-download-policy.py` re-proves (1) and (2) inside
 * every release candidate image.
 */

const ARTIFACT = process.env.VIDEOFETCH_PINNED_YTDLP_ARTIFACT || YTDLP_RUNTIME.artifactPath;
const PYTHON = process.env.VIDEOFETCH_PINNED_YTDLP_PYTHON || YTDLP_RUNTIME.pythonPath;

function pinnedArtifactStatus(): string | null {
  if (!existsSync(ARTIFACT)) return `pinned yt-dlp artifact not present at ${ARTIFACT}`;
  if (!existsSync(PYTHON)) return `interpreter not present at ${PYTHON}`;
  const digest = createHash("sha256").update(readFileSync(ARTIFACT)).digest("hex");
  if (digest !== YTDLP_RUNTIME.sha256) return `artifact digest ${digest} is not the pinned ${YTDLP_RUNTIME.sha256}`;
  return null;
}
const UNAVAILABLE = pinnedArtifactStatus();
const skip = UNAVAILABLE === null ? false : `SKIPPED — ${UNAVAILABLE}`;

/**
 * The hardened runner, with exactly two substitutions: the interpreter, and
 * argv[0] when it is the pinned artifact path. Nothing else — policy flags,
 * environment, timeout, signal and byte ceilings — is touched. Inside the image
 * both substitutions are identities.
 */
const pinnedRunner: typeof runProcess = (opts) => {
  assert.equal(opts.command, YTDLP_RUNTIME.pythonPath, "only yt-dlp is ever run through this adapter");
  assert.equal(opts.args[0], YTDLP_RUNTIME.artifactPath);
  return runProcess({ ...opts, command: PYTHON, args: [ARTIFACT, ...opts.args.slice(1)] });
};

const pinnedProbe = async (): Promise<YtdlpRuntimeStatus> => {
  const r = await pinnedRunner({
    command: YTDLP_RUNTIME.pythonPath,
    args: [YTDLP_RUNTIME.artifactPath, ...ytdlpPolicyArgs(), "--version"],
    timeoutMs: 30_000,
    env: buildYtdlpEnvironment(),
  });
  const version = r.stdout.trim();
  assert.equal(version, YTDLP_RUNTIME.expectedVersion);
  return { available: true, version, reason: "ok" };
};

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2: downloader selection, read out of the pinned code under OUR argv.
// ─────────────────────────────────────────────────────────────────────────────

const SELECTION_PROBE = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import yt_dlp
from yt_dlp.version import __version__
from yt_dlp.downloader import get_suitable_downloader
from yt_dlp.downloader.external import FFmpegFD

req = json.loads(sys.argv[2])

def params(argv):
    return yt_dlp.parse_options(argv).ydl_opts

def name(cls):
    return cls.__name__ if cls else None

def select(p, protocol, is_live):
    info = {"protocol": protocol, "url": "https://example.invalid/m", "is_live": is_live,
            "fragments": [{"url": "https://example.invalid/f1"}]}
    top = get_suitable_downloader(dict(info), p)
    # Exactly the lookup DashSegmentsFD.real_download makes for its fragments.
    inner = get_suitable_downloader(dict(info), p, None, protocol="dash_frag_urls", to_stdout=False)
    return {"fd": name(top), "fragmentDelegate": name(inner)}

def table(p):
    return {f"{proto}|{str(live).lower()}": select(p, proto, live)
            for proto in req["protocols"] for live in (False, True)}

ours = params(req["argv"])
out = {
    "version": __version__,
    "params": {k: ours.get(k) for k in (
        "external_downloader", "skip_unavailable_fragments", "concurrent_fragment_downloads",
        "keep_fragments", "fixup", "ffmpeg_location", "max_filesize", "format", "outtmpl")},
    "ffmpegAvailable": bool(FFmpegFD.available()),
    "ours": table(ours),
    # Control: the same argv WITHOUT the abort flag keeps the pinned default.
    "withoutAbortFlag": params([a for a in req["argv"] if a != "--abort-on-unavailable-fragments"]).get("skip_unavailable_fragments"),
    # Control: the SAME protocols with NO downloader policy at all.
    "noNativePolicy": table(params([a for a in req["argv"] if not a.startswith("--downloader")])),
}
# FFmpeg availability must not move the selection: pretend it IS available.
FFmpegFD.available = classmethod(lambda cls, path=None: True)
out["oursWithFfmpeg"] = table(ours)
json.dump(out, sys.stdout)
`;

type Selection = { fd: string | null; fragmentDelegate: string | null };
type SelectionReport = {
  version: string;
  params: Record<string, unknown>;
  ffmpegAvailable: boolean;
  ours: Record<string, Selection>;
  oursWithFfmpeg: Record<string, Selection>;
  noNativePolicy: Record<string, Selection>;
  withoutAbortFlag: unknown;
};

const DASH_PAIR: GenericSplitExecutionPlan = {
  strategy: "yt-dlp",
  operation: "merge-split",
  requestedFormatId: "preset:1080",
  pair: {
    video: {
      formatId: "v1080", protocol: "http_dash_segments", container: "mp4", hasVideo: true, hasAudio: false,
      videoConstraint: "codec-present", audioConstraint: "absent", fileSize: null,
    },
    audio: {
      formatId: "a128", protocol: "http_dash_segments", container: "m4a", hasVideo: false, hasAudio: true,
      videoConstraint: "absent", audioConstraint: "codec-present", fileSize: null,
    },
  },
  targetContainer: "mp4",
};

describe("pinned runtime: DASH downloader selection under the REAL acquisition argv", { skip }, () => {
  let report: SelectionReport;
  before(async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vf-dash-contract-"));
    try {
      const argv = buildYtdlpSplitDownloadArgv({
        validatedUrl: "https://example.invalid/watch/dash",
        workDir,
        plan: DASH_PAIR,
        role: "video",
        maxFileSizeBytes: 1000,
      });
      const request = JSON.stringify({
        // argv[0] is the artifact path; the option parser gets the rest.
        argv: argv.slice(1),
        protocols: ["http", "https", "http_dash_segments", "http_dash_segments_generator", "m3u8_native", "m3u8"],
      });
      const r: RunResult = await runProcess({
        command: PYTHON,
        args: ["-c", SELECTION_PROBE, ARTIFACT, request],
        timeoutMs: 60_000,
        env: buildYtdlpDownloadEnvironment({ workDir }),
      });
      assert.equal(r.code, 0, r.stderr.slice(0, 2000));
      report = JSON.parse(r.stdout) as SelectionReport;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("is the exact pinned version", () => {
    assert.equal(report.version, YTDLP_RUNTIME.expectedVersion);
  });

  it("http_dash_segments → DashSegmentsFD with NO fragment delegate, live or not", () => {
    for (const live of [false, true]) {
      assert.deepEqual(report.ours[`http_dash_segments|${live}`], { fd: "DashSegmentsFD", fragmentDelegate: null }, `live=${live}`);
    }
  });

  it("http and https → HttpFD", () => {
    for (const proto of ["http", "https"]) {
      for (const live of [false, true]) assert.equal(report.ours[`${proto}|${live}`]!.fd, "HttpFD", `${proto} live=${live}`);
    }
  });

  it("FFmpeg availability cannot change the selection", () => {
    assert.equal(report.ffmpegAvailable, false, "under the dead PATH the pinned runtime sees no FFmpeg");
    assert.deepEqual(report.oursWithFfmpeg, report.ours, "pretending FFmpeg IS available moves nothing");
  });

  it("CONTROL: without the native policy, a live DASH source WOULD go to FFmpegFD", () => {
    // Proves the check above is meaningful: `--downloader=native` is what holds it.
    assert.equal(report.noNativePolicy["http_dash_segments|true"]!.fd, "FFmpegFD");
  });

  it("the unadmitted spellings select what the vocabulary's comment says", () => {
    // Recorded, not admitted: the generator is DashSegmentsFD too, but its
    // fragments are a live-polling callable; HLS stays HlsFD / FFmpegFD.
    assert.equal(report.ours["http_dash_segments_generator|false"]!.fd, "DashSegmentsFD");
    assert.equal(report.ours["m3u8_native|false"]!.fd, "HlsFD");
    assert.equal(report.ours["m3u8_native|true"]!.fd, "FFmpegFD");
  });

  it("the argv parses to: native, abort on unavailable fragments, one fragment in flight, none kept, no fixup", () => {
    assert.deepEqual(report.params.external_downloader, { default: "native" });
    assert.equal(report.params.skip_unavailable_fragments, false);
    assert.equal(report.params.concurrent_fragment_downloads, 1);
    assert.equal(report.params.keep_fragments, false);
    assert.equal(report.params.fixup, "never");
    assert.equal(report.params.max_filesize, 1000);
    assert.match(String(report.params.ffmpeg_location), /^\/nonexistent\//);
    assert.match(String(report.params.format), /\[protocol="http_dash_segments"\]/);
    // CONTROL: the pinned default is to SKIP a failed fragment.
    assert.equal(report.withoutAbortFlag, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3: the Worker's own analysis + acquisition, through the pinned artifact.
// ─────────────────────────────────────────────────────────────────────────────

type Segment = { readonly body: Buffer; readonly slowMs?: number; readonly status?: number; readonly chunked?: boolean };

/** A deterministic local segmented-DASH origin: one static MPD + SegmentList fragments. */
class DashOrigin {
  readonly requests: string[] = [];
  readonly segments: Map<string, Segment>;
  private server: Server | null = null;
  private port = 0;
  constructor(segments: Map<string, Segment>) {
    this.segments = segments;
  }

  mpd(): string {
    const list = (prefix: string, count: number) =>
      [`<Initialization sourceURL="${prefix}-init.mp4"/>`]
        .concat(Array.from({ length: count }, (_, i) => `<SegmentURL media="${prefix}-${i + 1}.m4s"/>`))
        .join("");
    const count = (prefix: string) => [...this.segments.keys()].filter((k) => k.startsWith(`${prefix}-`) && k.endsWith(".m4s")).length;
    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
 <Period id="p0" duration="PT8S">
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <Representation id="v1080" codecs="avc1.640028" width="1920" height="1080" frameRate="30" bandwidth="4000000">
    <SegmentList timescale="1000" duration="2000">${list("v", count("v"))}</SegmentList>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <Representation id="a128" codecs="mp4a.40.2" audioSamplingRate="48000" bandwidth="128000">
    <SegmentList timescale="1000" duration="2000">${list("a", count("a"))}</SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>
`;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      this.requests.push(path);
      if (path === "/clip.mpd") {
        const body = Buffer.from(this.mpd());
        res.writeHead(200, { "content-type": "application/dash+xml", "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      const seg = this.segments.get(path.slice(1));
      if (!seg || seg.status === 404) {
        res.writeHead(404, { "content-length": 0 });
        res.end();
        return;
      }
      const headers: Record<string, string | number> = { "content-type": "video/iso.segment" };
      if (!seg.chunked) headers["content-length"] = seg.body.length;
      res.writeHead(200, headers);
      if (req.method === "HEAD") return void res.end();
      if (!seg.slowMs) return void res.end(seg.body);
      // Streamed in pieces, so the fragment is observably IN FLIGHT.
      const pieces = 8;
      const size = Math.ceil(seg.body.length / pieces);
      let i = 0;
      const next = () => {
        if (res.destroyed) return;
        if (i >= pieces) return void res.end();
        res.write(seg.body.subarray(i * size, (i + 1) * size));
        i += 1;
        setTimeout(next, seg.slowMs);
      };
      next();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}/clip.mpd`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

const bytes = (tag: string, size: number) => Buffer.alloc(size, `${tag}|`);

function origin(overrides: Record<string, Partial<Segment>> = {}) {
  const base: Record<string, Segment> = {
    "v-init.mp4": { body: bytes("VINIT", 700) },
    "v-1.m4s": { body: bytes("V1", 24_000), slowMs: 25 },
    "v-2.m4s": { body: bytes("V2", 20_000), slowMs: 25 },
    "v-3.m4s": { body: bytes("V3", 22_000), slowMs: 25 },
    "v-4.m4s": { body: bytes("V4", 18_000), slowMs: 25 },
    "a-init.mp4": { body: bytes("AINIT", 600) },
    "a-1.m4s": { body: bytes("A1", 3_000), slowMs: 10 },
    "a-2.m4s": { body: bytes("A2", 3_000), slowMs: 10 },
  };
  for (const [k, v] of Object.entries(overrides)) base[k] = { ...base[k]!, ...v };
  return new DashOrigin(new Map(Object.entries(base)));
}

const concat = (o: DashOrigin, names: string[]) => Buffer.concat(names.map((n) => o.segments.get(n)!.body));

async function analyzeThroughPinned(url: string) {
  return analyzeGenericMediaInternal(url, {
    limits: { analysisTimeoutSeconds: 60, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 4 * 1024 ** 3 },
    ffmpegAvailable: true,
    runner: pinnedRunner,
    probeRuntime: pinnedProbe,
    // A loopback fixture: the Worker's SSRF gate would (correctly) refuse it.
    validateUrl: async (raw: string) => ({ url: raw, hostname: "127.0.0.1" }),
  });
}

function acquireThroughPinned(
  url: string,
  workDir: string,
  plan: GenericSplitExecutionPlan,
  maxFileSizeBytes: number,
  seen?: Set<string>,
  runner: typeof runProcess = pinnedRunner,
) {
  return downloadGenericSplitSources(url, workDir, plan, {
    limits: { maxFileSizeBytes, downloadTimeoutSeconds: 120 },
    runner,
    probeRuntime: pinnedProbe,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "127.0.0.1" }),
    sizePollMs: 5,
    readDir: async (p: string) => {
      const names = await fsReaddir(p);
      for (const n of names) seen?.add(n);
      return names;
    },
  });
}

describe("pinned runtime: the Worker's analysis and acquisition of a real segmented MPD", { skip, timeout: 240_000 }, () => {
  let workDir = "";
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "vf-dash-acq-"));
  });
  after(() => rmSync(workDir, { recursive: true, force: true }));
  const fresh = () => {
    rmSync(workDir, { recursive: true, force: true });
    workDir = mkdtempSync(join(tmpdir(), "vf-dash-acq-"));
    return workDir;
  };

  it("analysis: the pinned extractor reports http_dash_segments, and preset:1080 is a DASH+DASH split", async () => {
    const o = origin();
    const url = await o.start();
    try {
      const analysis = await analyzeThroughPinned(url);
      const { video, selections } = analysis;
      assert.deepEqual(
        video.presets.map((p) => [p.id, p.resolution, p.container, p.hasAudio]),
        [
          ["preset:best", "1080p", "mp4", true],
          ["preset:1080", "1080p", "mp4", true],
        ],
      );
      assert.equal(video.sourceQuality?.observedMaxHeight, 1080);
      assert.equal(video.sourceQuality?.deliverableMaxHeight, 1080);
      assert.deepEqual(video.sourceQuality?.withheld, []);
      const value = selections["preset:1080"];
      assert.equal(value?.kind, "split");
      if (value?.kind !== "split") return;
      assert.deepEqual(
        [value.pair.video.formatId, value.pair.video.protocol, value.pair.video.container, value.pair.video.videoConstraint, value.pair.video.audioConstraint],
        ["v1080", "http_dash_segments", "mp4", "codec-present", "absent"],
      );
      assert.deepEqual(
        [value.pair.audio.formatId, value.pair.audio.protocol, value.pair.audio.container, value.pair.audio.videoConstraint, value.pair.audio.audioConstraint],
        ["a128", "http_dash_segments", "m4a", "absent", "codec-present"],
      );
      const plan = deriveExecutionPlan({ strategy: "yt-dlp", ...analysis }, "preset:1080");
      assert.equal(plan.strategy === "yt-dlp" && plan.generic.operation, "merge-split");
      // Analysis fetched the manifest and nothing else.
      assert.deepEqual([...new Set(o.requests)], ["/clip.mpd"]);
    } finally {
      await o.stop();
    }
  });

  it("acquisition: DashSegmentsFD's real grammar, byte-exact aggregates, and nothing left behind", async () => {
    const o = origin();
    const url = await o.start();
    const seen = new Set<string>();
    try {
      const res = await acquireThroughPinned(url, fresh(), DASH_PAIR, 4 * 1024 ** 3, seen);
      assert.deepEqual(
        readFileSync(res.video.filePath),
        concat(o, ["v-init.mp4", "v-1.m4s", "v-2.m4s", "v-3.m4s", "v-4.m4s"]),
        "the video artifact is exactly init + every fragment, in order",
      );
      assert.deepEqual(readFileSync(res.audio.filePath), concat(o, ["a-init.mp4", "a-1.m4s", "a-2.m4s"]));
      assert.equal(res.totalFileSize, 700 + 84_000 + 600 + 6_000);
      assert.deepEqual(readdirSync(workDir).sort(), ["audio-source.m4a", "video-source.mp4"]);

      // Every name the pinned downloader created while the monitor watched is
      // one the grammar knows — the emulation in the acquisition tests is real.
      const own = [...seen].filter((n) => n !== "video-source.mp4" && n !== "audio-source.m4a");
      for (const name of own) {
        const final = name.startsWith("video-source") ? "video-source.mp4" : "audio-source.m4a";
        assert.notEqual(classifySegmentedAcquisitionEntry(final, name), "unexpected", name);
      }
      for (const name of ["video-source.mp4.ytdl", "video-source.mp4.part", "video-source.mp4.part-Frag2.part"]) {
        assert.ok(seen.has(name), `never observed ${name}; observed: ${own.sort().join(", ")}`);
      }
    } finally {
      await o.stop();
    }
  });

  it("an unavailable middle fragment FAILS the run (with the flag), never a silently shorter artifact", async () => {
    const o = origin({ "v-3.m4s": { status: 404 } });
    const url = await o.start();
    try {
      await assert.rejects(
        () => acquireThroughPinned(url, fresh(), DASH_PAIR, 4 * 1024 ** 3),
        (err: unknown) => err instanceof AppError && err.code === "EXTRACTION_FAILED",
      );
      assert.equal(existsSync(join(workDir, "video-source.mp4")), false, "no final artifact");
    } finally {
      await o.stop();
    }
  });

  it("CONTROL: the SAME source without --abort-on-unavailable-fragments exits 0 with media missing", async () => {
    const o = origin({ "v-3.m4s": { status: 404 } });
    const url = await o.start();
    const withoutFlag: typeof runProcess = (opts) =>
      pinnedRunner({ ...opts, args: opts.args.filter((a) => a !== "--abort-on-unavailable-fragments") });
    try {
      const res = await acquireThroughPinned(url, fresh(), DASH_PAIR, 4 * 1024 ** 3, undefined, withoutFlag);
      assert.deepEqual(
        readFileSync(res.video.filePath),
        concat(o, ["v-init.mp4", "v-1.m4s", "v-2.m4s", "v-4.m4s"]),
        "the pinned default skips fragment 3 and reports success",
      );
    } finally {
      await o.stop();
    }
  });

  it("a fragment streamed past the allowance with no Content-Length is stopped by the guard: TOO_LARGE", async () => {
    const o = origin({ "v-2.m4s": { body: bytes("BIG", 400_000), slowMs: 40, chunked: true } });
    const url = await o.start();
    try {
      await assert.rejects(
        () => acquireThroughPinned(url, fresh(), DASH_PAIR, 100_000),
        (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
      );
    } finally {
      await o.stop();
    }
  });

  it("DOCUMENTED RESIDUAL: a fragment whose DECLARED length alone exceeds the allowance fails as a fragment", async () => {
    // The pinned per-fragment quiet HttpFD refuses it before writing a byte and
    // prints no witness; the run exits non-zero. Fail-closed, zero bytes, but
    // not TOO_LARGE — see `--max-filesize` in `ytdlpDownloadPolicyArgs`.
    const o = origin({ "v-2.m4s": { body: bytes("BIG", 400_000) } });
    const url = await o.start();
    try {
      await assert.rejects(
        () => acquireThroughPinned(url, fresh(), DASH_PAIR, 100_000),
        (err: unknown) => err instanceof AppError && err.code === "EXTRACTION_FAILED",
      );
      assert.equal(o.requests.filter((r) => r === "/v-3.m4s").length, 0, "nothing after the refused fragment");
    } finally {
      await o.stop();
    }
  });
});
