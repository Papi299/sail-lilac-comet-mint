import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AppError } from "../../lib/errors.ts";
import { createAcquisitionActivityTracker } from "../../services/downloads/acquisition-activity.ts";
import { runProcess, type RunResult } from "../../services/processing/process-runner.server.ts";
import { analyzeGenericMediaInternal } from "../analysis/ytdlp-analysis.server.ts";
import { deriveExecutionPlan, type GenericSingleSourceExecutionPlan, type GenericSplitExecutionPlan } from "../execution/format-plan.ts";
import {
  YTDLP_ACQUISITION_RETRY_POLICIES,
  buildYtdlpDownloadArgv,
  buildYtdlpDownloadEnvironment,
  downloadGenericOriginal,
  downloadGenericSplitSources,
  type GenericDownloadDeps,
} from "../execution/ytdlp-download.server.ts";
import { YTDLP_RUNTIME, buildYtdlpEnvironment, ytdlpPolicyArgs, type YtdlpRuntimeStatus } from "./ytdlp-runtime.server.ts";

/**
 * VIDEOFETCH-LD3D-YTDLP-RETRY-SAFEGUARDS-001 — the PINNED-RUNTIME retry contract.
 *
 * The retry policy's unit tests prove the Worker's side against fakes. This file
 * runs the EXACT pinned yt-dlp artifact — its digest is checked against
 * `YTDLP_RUNTIME.sha256` before anything executes — under the Worker's REAL
 * acquisition argv and REAL seam, against a loopback origin whose every request
 * is scripted and counted, and proves what the policy rests on:
 *
 *   1. both policies parse to their intended values; a budget of N is N + 1
 *      attempts with no sleep; nothing else retries, sleeps or skips;
 *   2. progressive: a cut connection resumes with `Range`, a server ignoring
 *      `Range` restarts the file, and either way the artifact is byte-exact;
 *      a 5xx is retried exactly the budget, a 404 never; an exhausted retry is
 *      classified by its last error; the deadline and a cancellation end a
 *      silent wait with no request after; a resumed response past the allowance
 *      is TOO_LARGE;
 *   3. the reason for the larger budget: under `bounded` the per-file budget
 *      ends a source that keeps delivering at its third silent pause, and the
 *      same source completes under `watched` without a retry;
 *   4. segmented: a fragment's 5xx spends its HTTP budget, a 4xx its fragment
 *      budget; an exhausted fragment ends the run and is never skipped; a cut
 *      fragment resumes, a restarted one is not duplicated;
 *   5. residue: the pinned runtime WOULD resume a stale `.part`; the Worker's
 *      seam refuses it before any request.
 *
 * WHERE IT RUNS. Inside the Worker image the artifact is at its pinned path and
 * this file runs with no configuration. Elsewhere it runs only when pointed at a
 * copy by `VIDEOFETCH_PINNED_YTDLP_ARTIFACT` (and an interpreter by
 * `VIDEOFETCH_PINNED_YTDLP_PYTHON`), and ONLY if that copy's digest equals the
 * pin; otherwise every test SKIPS and says why — exactly the rule of
 * `ytdlp-dash-downloader-contract.server.test.ts`.
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

/** Every child this file ran: its stderr, and its stdout's own retry status lines, for the assertions on the pinned report lines. */
const stderrs: string[] = [];
const retryLines: string[][] = [];

/** The hardened runner, with exactly two substitutions: the interpreter, and argv[0] when it is the pinned artifact path. */
const pinnedRunner: typeof runProcess = async (opts) => {
  assert.equal(opts.command, YTDLP_RUNTIME.pythonPath, "only yt-dlp is ever run through this adapter");
  assert.equal(opts.args[0], YTDLP_RUNTIME.artifactPath);
  const r: RunResult = await runProcess({ ...opts, command: PYTHON, args: [ARTIFACT, ...opts.args.slice(1)] });
  stderrs.push(r.stderr);
  retryLines.push(r.stdout.split(/[\r\n]+/).filter((l) => /^\[download\] Got error: .*Retrying/.test(l)));
  return r;
};

const pinnedProbe = async (): Promise<YtdlpRuntimeStatus> => {
  const r = await runProcess({
    command: PYTHON,
    args: [ARTIFACT, ...ytdlpPolicyArgs(), "--version"],
    timeoutMs: 30_000,
    env: buildYtdlpEnvironment(),
  });
  assert.equal(r.stdout.trim(), YTDLP_RUNTIME.expectedVersion);
  return { available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" };
};

const loopback = async (raw: string) => ({ url: raw, hostname: "127.0.0.1" });

// ─────────────────────────────────────────────────────────────────────────────
// 1: the policies through the pinned parser, and the pinned RetryManager.
// ─────────────────────────────────────────────────────────────────────────────

const PARSE_PROBE = String.raw`
import json, sys, time
sys.path.insert(0, sys.argv[1])
import yt_dlp
from yt_dlp.utils import RetryManager
req = json.loads(sys.argv[2])
keys = ("retries", "fragment_retries", "extractor_retries", "file_access_retries", "socket_timeout", "retry_sleep_functions",
        "skip_unavailable_fragments", "continuedl", "nopart", "overwrites", "ignoreerrors", "http_chunk_size", "throttledratelimit",
        "concurrent_fragment_downloads", "keep_fragments", "sleep_interval", "max_sleep_interval", "sleep_interval_requests", "wait_for_video")
out = {"params": {name: {k: yt_dlp.parse_options(argv).ydl_opts.get(k) for k in keys} for name, argv in req.items()}}
def attempts(n):
    seen = {"attempts": 0, "slept": 0.0}
    def cb(err, count, retries):
        t = time.monotonic()
        RetryManager.report_retry(err, count, retries, sleep_func=None, info=lambda *_: None, warn=lambda *_: None, error=lambda *_: None)
        seen["slept"] += time.monotonic() - t
    for retry in RetryManager(n, cb):
        seen["attempts"] += 1
        retry.error = Exception("synthetic")
    return seen
out["attempts"] = {str(n): attempts(n) for n in (1, 2, 3, 20)}
json.dump(out, sys.stdout)
`;

type ParseReport = {
  params: Record<"bounded" | "watched", Record<string, unknown>>;
  attempts: Record<string, { attempts: number; slept: number }>;
};

const PROGRESSIVE: GenericSingleSourceExecutionPlan = {
  strategy: "yt-dlp",
  operation: "keep-original",
  requestedFormatId: "preset:best",
  source: {
    formatId: "0", protocol: "http", container: "mp4", hasVideo: true, hasAudio: true,
    videoConstraint: "codec-present", audioConstraint: "codec-present", fileSize: null,
  },
  targetContainer: "mp4",
} as GenericSingleSourceExecutionPlan;

describe("pinned runtime: the two retry policies, read by the pinned parser and RetryManager", { skip }, () => {
  let report: ParseReport;
  before(async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vf-retry-contract-"));
    try {
      const argvFor = (retryPolicy: "bounded" | "watched") =>
        buildYtdlpDownloadArgv({ validatedUrl: "https://example.invalid/watch/abc", workDir, plan: PROGRESSIVE, maxFileSizeBytes: 1_000, retryPolicy }).slice(1);
      const r = await runProcess({
        command: PYTHON,
        args: ["-c", PARSE_PROBE, ARTIFACT, JSON.stringify({ bounded: argvFor("bounded"), watched: argvFor("watched") })],
        timeoutMs: 60_000,
        env: buildYtdlpDownloadEnvironment({ workDir }),
      });
      assert.equal(r.code, 0, r.stderr.slice(0, 2000));
      report = JSON.parse(r.stdout) as ParseReport;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("each policy parses to exactly its own four values", () => {
    for (const name of ["bounded", "watched"] as const) {
      const p = YTDLP_ACQUISITION_RETRY_POLICIES[name];
      assert.deepEqual(
        [report.params[name].socket_timeout, report.params[name].retries, report.params[name].fragment_retries, report.params[name].extractor_retries],
        [p.socketTimeoutSeconds, p.retries, p.fragmentRetries, p.extractorRetries],
        name,
      );
    }
  });

  it("nothing else retries, sleeps, chunks or skips; errors are reported (exit 1), never raised past the run", () => {
    for (const name of ["bounded", "watched"] as const) {
      const p = report.params[name];
      assert.deepEqual(p.retry_sleep_functions, {}, `${name}: no retry sleep of any kind`);
      assert.equal(p.file_access_retries, 3, `${name}: the pinned default, finite`);
      for (const key of ["http_chunk_size", "throttledratelimit", "sleep_interval", "max_sleep_interval", "sleep_interval_requests", "wait_for_video"]) {
        assert.equal(p[key], null, `${name}: ${key}`);
      }
      assert.equal(p.skip_unavailable_fragments, false, `${name}: a failed fragment aborts`);
      assert.equal(p.concurrent_fragment_downloads, 1);
      assert.equal(p.keep_fragments, false);
      assert.equal(p.continuedl, true, `${name}: the pinned default resumes a .part (why residue is refused)`);
      assert.equal(p.ignoreerrors, "only_download");
    }
  });

  it("a budget of N is N + 1 attempts, with no sleep between them", () => {
    for (const [n, expected] of [["1", 2], ["2", 3], ["3", 4], ["20", 21]] as const) {
      assert.equal(report.attempts[n]!.attempts, expected, `retries=${n}`);
      assert.equal(report.attempts[n]!.slept < 0.05, true, `retries=${n}: no sleep`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3: progressive retries through the Worker's seam.
// ─────────────────────────────────────────────────────────────────────────────

/** `at` is ABSOLUTE (`performance.now()`), so it compares directly with a run's settle instant. */
type Logged = { readonly at: number; readonly route: string; readonly range: string | null; status: number | null };
type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

/** A deterministic loopback origin: one page with one <video><source>, one media route, and SegmentList DASH routes. */
class Origin {
  readonly log: Logged[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private gets = new Map<string, number>();
  private readonly handlers: { media?: Handler; segments?: Record<string, Handler> };
  base = "";
  constructor(handlers: { media?: Handler; segments?: Record<string, Handler> } = {}) {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      const entry: Logged = { at: performance.now(), route: path.slice(1), range: req.headers.range ?? null, status: null };
      this.log.push(entry);
      const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => ServerResponse;
      (res as unknown as { writeHead: unknown }).writeHead = (status: number, ...rest: unknown[]) => {
        entry.status = status;
        return writeHead(status, ...rest);
      };
      if (path === "/watch") {
        const body = Buffer.from(`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>retry contract</title>\n</head>\n<body>\n<h1>retry contract</h1>\n<video controls preload="none">\n<source src="/media.mp4" type='video/mp4; codecs="avc1.42E01E, mp4a.40.2"'>\n</video>\n</body>\n</html>\n`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
        return void res.end(req.method === "HEAD" ? undefined : body);
      }
      if (path === "/clip.mpd") {
        const body = Buffer.from(MPD);
        res.writeHead(200, { "content-type": "application/dash+xml", "content-length": body.length });
        return void res.end(req.method === "HEAD" ? undefined : body);
      }
      const route = path.slice(1);
      const n = (this.gets.get(route) ?? 0) + 1;
      this.gets.set(route, n);
      const handler = route === "media.mp4" ? this.handlers.media : this.handlers.segments?.[route];
      if (handler) return handler(req, res, n);
      const segment = SEGMENTS[route];
      if (segment) return serve(req, res, segment);
      res.writeHead(404, { "content-length": 0 });
      res.end();
    });
    this.server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  requests(route: string): Logged[] {
    return this.log.filter((e) => e.route === route);
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

const MEDIA = (() => {
  const b = Buffer.alloc(512 * 1024);
  for (let i = 0; i < b.length; i += 32) createHash("sha256").update(`ld3d-contract-${i}`).digest().copy(b, i);
  return b;
})();

const parseRange = (h: string | undefined) => {
  const m = /^bytes=(\d+)-(\d*)$/.exec(h ?? "");
  return m ? { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) } : null;
};
/** 200 with the whole body, or 206 for a `Range` request, honoured exactly. */
function serve(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const r = parseRange(req.headers.range);
  if (!r) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": body.length, "accept-ranges": "bytes" });
    return void res.end(body);
  }
  const end = r.end === null ? body.length - 1 : Math.min(r.end, body.length - 1);
  res.writeHead(206, { "content-type": "video/mp4", "content-length": end - r.start + 1, "content-range": `bytes ${r.start}-${end}/${body.length}` });
  res.end(body.subarray(r.start, end + 1));
}
const status = (res: ServerResponse, code: number) => {
  res.writeHead(code, { "content-length": 0 });
  res.end();
};
/** Headers for the whole (remaining) body, `upTo` bytes of it, then the connection is cut. `chunked` drops Content-Length. */
function cutAt(req: IncomingMessage, res: ServerResponse, upTo: number, body: Buffer = MEDIA, chunked = false) {
  const start = parseRange(req.headers.range)?.start ?? 0;
  const headers: Record<string, string | number> = { "content-type": "video/mp4" };
  if (!chunked) headers["content-length"] = body.length - start;
  if (start > 0) headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
  res.writeHead(start > 0 ? 206 : 200, headers);
  res.write(body.subarray(start, Math.min(upTo, body.length)), () => setTimeout(() => res.socket?.destroy(), 30));
}
/** Headers, then nothing: the socket stays open and silent. */
function silent(res: ServerResponse) {
  res.writeHead(200, { "content-type": "video/mp4", "content-length": MEDIA.length });
  res.flushHeaders();
}
/** On EVERY connection: a burst of `burst` bytes from the requested start, a pause of `pauseMs`, the next burst, … */
function bursts(req: IncomingMessage, res: ServerResponse, burst: number, pauseMs: number) {
  let pos = parseRange(req.headers.range)?.start ?? 0;
  const headers: Record<string, string | number> = { "content-type": "video/mp4", "content-length": MEDIA.length - pos };
  if (pos > 0) headers["content-range"] = `bytes ${pos}-${MEDIA.length - 1}/${MEDIA.length}`;
  res.writeHead(pos > 0 ? 206 : 200, headers);
  const next = () => {
    if (res.destroyed || res.writableEnded) return;
    const stop = Math.min(pos + burst, MEDIA.length);
    res.write(MEDIA.subarray(pos, stop));
    pos = stop;
    if (pos >= MEDIA.length) return void res.end();
    setTimeout(next, pauseMs);
  };
  next();
}

const idleStops = () => ({ stopForInactivity: new AbortController().signal, stopForObservationLoss: new AbortController().signal });

let plan: GenericSingleSourceExecutionPlan = PROGRESSIVE;

async function acquire(origin: Origin, opts: { policy?: "bounded" | "watched"; limits?: Partial<GenericDownloadDeps["limits"]>; cancelAtMs?: number; before?: (dir: string) => void } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "vf-retry-contract-"));
  const tracker = createAcquisitionActivityTracker({ clock: () => performance.now() });
  const caller = new AbortController();
  const timer = opts.cancelAtMs ? setTimeout(() => caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled")), opts.cancelAtMs) : null;
  opts.before?.(workDir);
  const firstRun = stderrs.length;
  let result: { bytes: Buffer } | { error: unknown };
  try {
    const res = await downloadGenericOriginal(`${origin.base}/watch`, workDir, plan, {
      limits: { maxFileSizeBytes: 4 * 1024 ** 3, downloadTimeLimitMs: 120_000, ...opts.limits },
      runner: pinnedRunner,
      probeRuntime: pinnedProbe,
      validateUrl: loopback,
      activity: tracker.record,
      signal: caller.signal,
      sizePollMs: 25,
      ...(opts.policy === "watched" ? idleStops() : {}),
    });
    result = { bytes: readFileSync(res.filePath) };
  } catch (err: unknown) {
    result = { error: err };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const settledAt = performance.now();
  // Anything the child — or a survivor — would still request arrives here.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const leftover = existsSync(workDir) ? readdirSync(workDir).sort() : [];
  rmSync(workDir, { recursive: true, force: true });
  return { result, tracker: tracker.snapshot(), settledAt, leftover, origin, stderr: stderrs.slice(firstRun).join("\n"), retries: retryLines.slice(firstRun).flat() };
}

const codeOf = (result: { error?: unknown }) => (result.error instanceof AppError ? result.error.code : `not an AppError: ${String(result.error)}`);
const isCancelled = (result: { error?: unknown }) => result.error instanceof AppError && result.error.message === "Download was cancelled.";

describe("pinned runtime: progressive retries through the Worker's own seam", { skip, timeout: 300_000 }, () => {
  before(async () => {
    // The plan is the Worker's own analysis of the fixture page, through the pinned runtime.
    const origin = new Origin({ media: (req, res) => serve(req, res, MEDIA) });
    await origin.start();
    try {
      const analysis = await analyzeGenericMediaInternal(`${origin.base}/watch`, {
        limits: { analysisTimeoutSeconds: 60, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 4 * 1024 ** 3 },
        ffmpegAvailable: true,
        runner: pinnedRunner,
        probeRuntime: pinnedProbe,
        validateUrl: loopback,
      });
      const derived = deriveExecutionPlan({ strategy: "yt-dlp", ...analysis }, "preset:best");
      assert.equal(derived.strategy === "yt-dlp" && derived.generic.operation, "keep-original");
      if (derived.strategy === "yt-dlp" && derived.generic.operation === "keep-original") plan = derived.generic as GenericSingleSourceExecutionPlan;
      assert.deepEqual([plan.source.protocol, plan.source.container], ["http", "mp4"]);
    } finally {
      await origin.stop();
    }
  });

  it("a connection cut mid-body is resumed with Range from the .part's size: one byte-exact artifact", async () => {
    const o = new Origin({ media: (req, res, n) => (n === 1 ? cutAt(req, res, 200_000) : serve(req, res, MEDIA)) });
    await o.start();
    try {
      const { result } = await acquire(o);
      assert.ok("bytes" in result, codeOf(result as { error?: unknown }));
      assert.deepEqual(result.bytes, MEDIA);
      assert.deepEqual(o.requests("media.mp4").map((e) => [e.range, e.status]), [[null, 200], ["bytes=200000-", 206]]);
    } finally {
      await o.stop();
    }
  });

  it("a server ignoring Range makes yt-dlp restart the file: still byte-exact, nothing appended twice", async () => {
    const o = new Origin({ media: (req, res, n) => (n === 1 ? cutAt(req, res, 200_000) : (res.writeHead(200, { "content-length": MEDIA.length }), res.end(MEDIA))) });
    await o.start();
    try {
      const { result } = await acquire(o);
      assert.ok("bytes" in result);
      assert.equal(result.bytes.length, MEDIA.length);
      assert.deepEqual(result.bytes, MEDIA);
      assert.deepEqual(o.requests("media.mp4").map((e) => [e.range, e.status]), [[null, 200], ["bytes=200000-", 200]]);
    } finally {
      await o.stop();
    }
  });

  for (const policy of ["bounded", "watched"] as const) {
    it(`${policy}: a persistent 503 is retried exactly the budget (retries + 1 requests), then NETWORK_ERROR with no artifact`, async () => {
      const o = new Origin({ media: (req, res) => status(res, 503) });
      await o.start();
      try {
        const { result, leftover, settledAt, origin, stderr } = await acquire(o, { policy });
        assert.equal(codeOf(result as { error?: unknown }), "NETWORK_ERROR");
        assert.match(stderr, /\[download\] Got error: HTTP Error 503: Service Unavailable\. Giving up after \d+ retries/);
        assert.equal(o.requests("media.mp4").length, YTDLP_ACQUISITION_RETRY_POLICIES[policy].retries + 1);
        assert.equal(origin.log.filter((e) => e.at > settledAt).length, 0, "no request after the run settled");
        assert.deepEqual(leftover, []);
      } finally {
        await o.stop();
      }
    });
  }

  it("a 404 is never retried: one request, and the run fails", async () => {
    const o = new Origin({ media: (req, res) => status(res, 404) });
    await o.start();
    try {
      const { result } = await acquire(o);
      assert.equal(codeOf(result as { error?: unknown }), "NETWORK_ERROR");
      assert.equal(o.requests("media.mp4").length, 1);
    } finally {
      await o.stop();
    }
  });

  it("a persistent 504 is a NETWORK_ERROR, not a TIMEOUT for its reason phrase", async () => {
    const o = new Origin({ media: (req, res) => status(res, 504) });
    await o.start();
    try {
      const { result, stderr } = await acquire(o);
      assert.match(stderr, /HTTP Error 504: Gateway Timeout\. Giving up after 2 retries/);
      assert.equal(codeOf(result as { error?: unknown }), "NETWORK_ERROR");
    } finally {
      await o.stop();
    }
  });

  it("connections persistently cut short (declared and chunked): NETWORK_ERROR, by the pinned short-read lines", async () => {
    for (const chunked of [false, true]) {
      const o = new Origin({ media: (req, res) => cutAt(req, res, (parseRange(req.headers.range)?.start ?? 0) + 4_096, MEDIA, chunked) });
      await o.start();
      try {
        const { result, stderr } = await acquire(o);
        assert.equal(codeOf(result as { error?: unknown }), "NETWORK_ERROR", `chunked=${chunked}`);
        assert.match(stderr, chunked ? /Got error: \d+ bytes read(, \d+ more expected)?\. Giving up after 2 retries/ : /Got error: Downloaded \d+ bytes, expected \d+ bytes\. Giving up after 2 retries/);
        assert.equal(o.requests("media.mp4").length, 3);
      } finally {
        await o.stop();
      }
    }
  });

  it("a cancellation while yt-dlp waits on a silent socket ends the run at once: cancelled, nothing requested after", async () => {
    const o = new Origin({ media: (req, res) => silent(res) });
    await o.start();
    try {
      const { result, tracker, settledAt, origin } = await acquire(o, { cancelAtMs: 2_500 });
      assert.equal(isCancelled(result as { error?: unknown }), true);
      assert.equal(tracker.outcome, "cancelled");
      assert.equal(origin.log.filter((e) => e.at > settledAt).length, 0);
    } finally {
      await o.stop();
    }
  });

  it("the absolute deadline during a silent wait: the runner's TIMEOUT, settled deadline-exceeded, nothing requested after", async () => {
    const o = new Origin({ media: (req, res) => silent(res) });
    await o.start();
    try {
      const { result, tracker, settledAt, origin } = await acquire(o, { limits: { downloadTimeLimitMs: 5_000 } });
      assert.equal(codeOf(result as { error?: unknown }), "TIMEOUT");
      assert.equal(tracker.outcome, "deadline-exceeded");
      assert.equal(origin.log.filter((e) => e.at > settledAt).length, 0);
      assert.equal(o.requests("media.mp4").length, 1, "the 10 s socket timeout never fired inside a 5 s deadline");
    } finally {
      await o.stop();
    }
  });

  it("a resumed response whose declared total exceeds the allowance is refused: TOO_LARGE", async () => {
    const o = new Origin({
      media: (req, res, n) => {
        if (n === 1) return cutAt(req, res, 300_000);
        const start = parseRange(req.headers.range)!.start;
        res.writeHead(206, { "content-type": "video/mp4", "content-length": 900_000 - start, "content-range": `bytes ${start}-899999/900000` });
        res.end();
      },
    });
    await o.start();
    try {
      const { result } = await acquire(o, { limits: { maxFileSizeBytes: 700_000 } });
      assert.equal(codeOf(result as { error?: unknown }), "TOO_LARGE");
    } finally {
      await o.stop();
    }
  });

  it("an HTTP 416 on a resume fails the run (the pinned re-request still carries Range); no artifact", async () => {
    const o = new Origin({ media: (req, res, n) => (n === 1 ? cutAt(req, res, 200_000) : status(res, 416)) });
    await o.start();
    try {
      const { result } = await acquire(o);
      assert.equal(codeOf(result as { error?: unknown }), "NETWORK_ERROR");
      assert.deepEqual(o.requests("media.mp4").map((e) => e.range), [null, "bytes=200000-", "bytes=200000-"]);
    } finally {
      await o.stop();
    }
  });

  it("residue: the pinned runtime WOULD resume a stale .part (control); the Worker's seam refuses it before any request", async () => {
    const stale = Buffer.alloc(1_000, 0x5a);
    // CONTROL: the real child, the real argv, a directory holding a stale .part.
    const control = new Origin({ media: (req, res) => serve(req, res, MEDIA) });
    await control.start();
    const dir = mkdtempSync(join(tmpdir(), "vf-retry-contract-"));
    try {
      writeFileSync(join(dir, "source.mp4.part"), stale);
      const argv = buildYtdlpDownloadArgv({ validatedUrl: `${control.base}/watch`, workDir: dir, plan, maxFileSizeBytes: 4 * 1024 ** 3 });
      const r = await pinnedRunner({ command: YTDLP_RUNTIME.pythonPath, args: [...argv], timeoutMs: 60_000, env: buildYtdlpDownloadEnvironment({ workDir: dir }) });
      assert.equal(r.code, 0);
      assert.deepEqual(control.requests("media.mp4").map((e) => e.range), ["bytes=1000-"], "the pinned default resumed the stale file");
      const spliced = readFileSync(join(dir, "source.mp4"));
      assert.deepEqual(spliced.subarray(0, 1_000), stale, "the stale bytes became the head of the 'download'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await control.stop();
    }
    // The seam, given the same residue.
    const o = new Origin({ media: (req, res) => serve(req, res, MEDIA) });
    await o.start();
    try {
      const { result, leftover } = await acquire(o, { before: (d) => writeFileSync(join(d, "source.mp4.part"), stale) });
      assert.equal(codeOf(result as { error?: unknown }), "PROCESSING_FAILED");
      assert.equal(o.requests("media.mp4").length, 0, "no media request at all");
      assert.equal(o.requests("watch").length, 0, "no child was spawned");
      assert.deepEqual(leftover, ["source.mp4.part"], "nothing was deleted and continued past");
    } finally {
      await o.stop();
    }
  });

  it("WHY the larger budget: a source that keeps delivering but pauses 11 s three times fails under `bounded` and completes under `watched` with no retry", async () => {
    // Every connection: 128 KiB at once, then 11 s of silence, then the next 128 KiB — the SAME source for both policies.
    const BURST = 128 * 1024;
    const bounded = new Origin({ media: (req, res) => bursts(req, res, BURST, 11_000) });
    await bounded.start();
    try {
      const { result, tracker, stderr } = await acquire(bounded, { policy: "bounded" });
      assert.equal(codeOf(result as { error?: unknown }), "TIMEOUT");
      assert.match(stderr, /Got error: timed out\. Giving up after 2 retries/);
      assert.equal(tracker.outcome, "failed", "yt-dlp's own exhaustion, never the absolute deadline");
      assert.equal(bounded.requests("media.mp4").length, 3);
      assert.equal(tracker.observedBytes >= 2 * 65_536, true, "it was delivering meaningful bytes between the pauses");
    } finally {
      await bounded.stop();
    }
    const watched = new Origin({ media: (req, res) => bursts(req, res, BURST, 11_000) });
    await watched.start();
    try {
      const { result, retries } = await acquire(watched, { policy: "watched" });
      assert.ok("bytes" in result, codeOf(result as { error?: unknown }));
      assert.deepEqual(result.bytes, MEDIA);
      assert.equal(watched.requests("media.mp4").length, 1, "no retry was spent on 11 s pauses");
      assert.deepEqual(retries, []);
    } finally {
      await watched.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4: segmented fragment retries through the split seam (both halves DASH).
// ─────────────────────────────────────────────────────────────────────────────

const seg = (tag: string, size: number) => Buffer.alloc(size, `${tag}|`);
const SEGMENTS: Record<string, Buffer> = {
  "v-init.mp4": seg("VINIT", 700), "v-1.m4s": seg("V1", 24_000), "v-2.m4s": seg("V2", 20_000), "v-3.m4s": seg("V3", 22_000), "v-4.m4s": seg("V4", 18_000),
  "a-init.mp4": seg("AINIT", 600), "a-1.m4s": seg("A1", 3_000), "a-2.m4s": seg("A2", 3_000),
};
const list = (p: string, n: number) => [`<Initialization sourceURL="${p}-init.mp4"/>`].concat(Array.from({ length: n }, (_, i) => `<SegmentURL media="${p}-${i + 1}.m4s"/>`)).join("");
const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
 <Period id="p0" duration="PT8S">
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <Representation id="v1080" codecs="avc1.640028" width="1920" height="1080" frameRate="30" bandwidth="4000000">
    <SegmentList timescale="1000" duration="2000">${list("v", 4)}</SegmentList>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <Representation id="a128" codecs="mp4a.40.2" audioSamplingRate="48000" bandwidth="128000">
    <SegmentList timescale="1000" duration="2000">${list("a", 2)}</SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>
`;
const DASH_PAIR: GenericSplitExecutionPlan = {
  strategy: "yt-dlp",
  operation: "merge-split",
  requestedFormatId: "preset:1080",
  pair: {
    video: { formatId: "v1080", protocol: "http_dash_segments", container: "mp4", hasVideo: true, hasAudio: false, videoConstraint: "codec-present", audioConstraint: "absent", fileSize: null },
    audio: { formatId: "a128", protocol: "http_dash_segments", container: "m4a", hasVideo: false, hasAudio: true, videoConstraint: "absent", audioConstraint: "codec-present", fileSize: null },
  },
  targetContainer: "mp4",
};
const concat = (names: string[]) => Buffer.concat(names.map((n) => SEGMENTS[n]!));
const VIDEO = concat(["v-init.mp4", "v-1.m4s", "v-2.m4s", "v-3.m4s", "v-4.m4s"]);
const AUDIO = concat(["a-init.mp4", "a-1.m4s", "a-2.m4s"]);
const once = (code: number): Handler => (req, res, n) => (n === 1 ? status(res, code) : serve(req, res, SEGMENTS[(req.url ?? "/").slice(1)]!));

async function acquirePair(origin: Origin, opts: { policy?: "bounded" | "watched"; cancelAtMs?: number } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "vf-retry-contract-"));
  const caller = new AbortController();
  const timer = opts.cancelAtMs ? setTimeout(() => caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled")), opts.cancelAtMs) : null;
  const budgets: number[] = [];
  const firstRun = stderrs.length;
  let result: { video: Buffer; audio: Buffer } | { error: unknown };
  try {
    const res = await downloadGenericSplitSources(`${origin.base}/clip.mpd`, workDir, DASH_PAIR, {
      limits: { maxFileSizeBytes: 4 * 1024 ** 3, downloadTimeLimitMs: 120_000 },
      runner: (o) => {
        budgets.push(o.timeoutMs);
        return pinnedRunner(o);
      },
      probeRuntime: pinnedProbe,
      validateUrl: loopback,
      signal: caller.signal,
      sizePollMs: 5,
      ...(opts.policy === "watched" ? idleStops() : {}),
    });
    result = { video: readFileSync(res.video.filePath), audio: readFileSync(res.audio.filePath) };
  } catch (err: unknown) {
    result = { error: err };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const settledAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const leftover = existsSync(workDir) ? readdirSync(workDir).sort() : [];
  rmSync(workDir, { recursive: true, force: true });
  return { result, budgets, settledAt, leftover, stderr: stderrs.slice(firstRun).join("\n"), retries: retryLines.slice(firstRun).flat() };
}

describe("pinned runtime: segmented fragment retries through the split seam", { skip, timeout: 300_000 }, () => {
  it("a fragment answering 503 once is retried inside its HTTP budget and appended once: byte-exact", async () => {
    const o = new Origin({ segments: { "v-2.m4s": once(503) } });
    await o.start();
    try {
      const { result, retries } = await acquirePair(o);
      assert.ok("video" in result);
      assert.deepEqual(result.video, VIDEO);
      assert.deepEqual(result.audio, AUDIO);
      assert.deepEqual(o.requests("v-2.m4s").map((e) => e.status), [503, 200]);
      assert.deepEqual(retries, ["[download] Got error: HTTP Error 503: Service Unavailable. Retrying (1/2)..."], "the HTTP budget, never the fragment budget");
    } finally {
      await o.stop();
    }
  });

  it("a fragment answering 404 once is recovered by its FRAGMENT budget and appended once: byte-exact", async () => {
    const o = new Origin({ segments: { "v-2.m4s": once(404) } });
    await o.start();
    try {
      const { result, retries } = await acquirePair(o);
      assert.ok("video" in result);
      assert.deepEqual(result.video, VIDEO);
      assert.deepEqual(o.requests("v-2.m4s").map((e) => e.status), [404, 200]);
      assert.deepEqual(retries, ["[download] Got error: HTTP Error 404: Not Found. Retrying fragment 3 (1/1)..."], "the fragment budget");
    } finally {
      await o.stop();
    }
  });

  for (const policy of ["bounded", "watched"] as const) {
    it(`${policy}: a persistent fragment 404 spends the fragment budget (fragment retries + 1 requests) and ENDS the run — never skipped`, async () => {
      const o = new Origin({ segments: { "v-2.m4s": (req, res) => status(res, 404) } });
      await o.start();
      try {
        const { result, leftover, stderr } = await acquirePair(o, { policy });
        assert.equal(codeOf(result as { error?: unknown }), "EXTRACTION_FAILED");
        assert.match(stderr, /fragment 3 not found, unable to continue/);
        assert.equal(o.requests("v-2.m4s").length, YTDLP_ACQUISITION_RETRY_POLICIES[policy].fragmentRetries + 1);
        assert.equal(o.requests("v-3.m4s").length, 0, "nothing after the failed fragment");
        assert.equal(leftover.includes("video-source.mp4"), false, "no artifact");
      } finally {
        await o.stop();
      }
    });

    it(`${policy}: a persistent fragment 503 spends the fragment attempt's HTTP budget (retries + 1 requests), not its fragment budget, and ends the run`, async () => {
      const o = new Origin({ segments: { "v-2.m4s": (req, res) => status(res, 503) } });
      await o.start();
      try {
        const { result } = await acquirePair(o, { policy });
        assert.equal(codeOf(result as { error?: unknown }), "NETWORK_ERROR");
        assert.equal(o.requests("v-2.m4s").length, YTDLP_ACQUISITION_RETRY_POLICIES[policy].retries + 1);
        assert.equal(o.requests("v-3.m4s").length, 0);
      } finally {
        await o.stop();
      }
    });
  }

  it("a fragment cut short resumes with Range inside the fragment; one answering 200 to the Range restarts it — both byte-exact", async () => {
    for (const ignoreRange of [false, true]) {
      const o = new Origin({
        segments: {
          "v-2.m4s": (req, res, n) => {
            if (n === 1) return cutAt(req, res, 8_000, SEGMENTS["v-2.m4s"]!);
            if (ignoreRange) return (res.writeHead(200, { "content-length": SEGMENTS["v-2.m4s"]!.length }), res.end(SEGMENTS["v-2.m4s"]));
            return serve(req, res, SEGMENTS["v-2.m4s"]!);
          },
        },
      });
      await o.start();
      try {
        const { result } = await acquirePair(o);
        assert.ok("video" in result, `ignoreRange=${ignoreRange}`);
        assert.deepEqual(result.video, VIDEO, `ignoreRange=${ignoreRange}`);
        assert.deepEqual(o.requests("v-2.m4s").map((e) => e.range), [null, "bytes=8000-"]);
      } finally {
        await o.stop();
      }
    }
  });

  it("an audio fragment retried after the validated video half: both byte-exact, and the audio run has only what is left of the deadline", async () => {
    const o = new Origin({ segments: { "a-1.m4s": once(503) } });
    await o.start();
    try {
      const { result, budgets } = await acquirePair(o);
      assert.ok("video" in result);
      assert.deepEqual(result.video, VIDEO);
      assert.deepEqual(result.audio, AUDIO);
      assert.equal(budgets.length, 2);
      assert.equal(budgets[1]! < budgets[0]!, true, `audio ${budgets[1]} ms < video ${budgets[0]} ms`);
    } finally {
      await o.stop();
    }
  });

  it("a cancellation while a fragment's socket is silent ends the run: cancelled, no further fragment requested", async () => {
    const o = new Origin({ segments: { "v-2.m4s": (req, res) => { res.writeHead(200, { "content-length": 20_000 }); res.flushHeaders(); } } });
    await o.start();
    try {
      const { result, settledAt } = await acquirePair(o, { cancelAtMs: 3_000 });
      assert.equal(isCancelled(result as { error?: unknown }), true);
      assert.equal(o.log.filter((e) => e.at > settledAt).length, 0);
      assert.equal(o.requests("v-3.m4s").length, 0);
    } finally {
      await o.stop();
    }
  });
});

describe("pinned runtime: nothing survives the retry contract", { skip, timeout: 60_000 }, () => {
  /** Pids of processes holding the artifact path as an ARGUMENT, read by argument, never by this process's own command line. */
  const holders = async (): Promise<number[]> => {
    const r = await runProcess({ command: "/bin/ps", args: ["-axww", "-o", "pid=,args="], timeoutMs: 10_000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    return r.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length > 1 && Number(fields[0]) !== process.pid && fields.slice(1).includes(ARTIFACT))
      .map((fields) => Number(fields[0]));
  };

  it("no process running the pinned artifact outlives this file's runs (cancelled, timed out and exhausted ones included)", async () => {
    // Positive control: an idle interpreter holding the artifact path as a plain argument IS seen.
    const control = spawn(PYTHON, ["-c", "import time; time.sleep(30)", ARTIFACT], { stdio: "ignore" });
    try {
      let seen: number[] = [];
      for (let i = 0; i < 50 && !seen.includes(control.pid!); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        seen = await holders();
      }
      assert.deepEqual(seen, [control.pid], "the scan sees a holder of the artifact path");
    } finally {
      control.kill("SIGKILL");
      await new Promise((resolve) => (control.exitCode !== null || control.signalCode !== null ? resolve(null) : control.once("exit", resolve)));
    }
    assert.deepEqual(await holders(), []);
  });
});

after(() => {
  stderrs.length = 0;
  retryLines.length = 0;
});
