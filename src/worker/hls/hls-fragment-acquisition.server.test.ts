import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, truncateSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  setSafeHttpTestHooks,
  type DnsAnswer,
  type SafeRequestOnce,
} from "@/lib/security/safe-http.server.ts";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "@/shared/media-limits.ts";
import { YTDLP_V1_NATIVE_PROTOCOLS } from "../analysis/ytdlp-analysis.server.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../execution/generic-source.ts";
import { HLS_V1_MAX_FRAGMENTS } from "./hls-media-playlist.ts";
import {
  HLS_V1_MAX_FRAGMENT_URL_BYTES,
  preflightClearHlsMediaPlaylist,
  type ClearHlsAcquisitionPlan,
} from "./hls-preflight.server.ts";
import {
  ClearHlsAcquisitionError,
  HLS_V1_MAX_AGGREGATE_BYTES,
  HLS_V1_MAX_FRAGMENT_BYTES,
  HLS_V1_MAX_FRAGMENT_REDIRECTS,
  acquireClearHlsTs,
  hlsV1EffectiveAggregateLimitBytes,
  setClearHlsFinalizationBarrierForTests,
  type ClearHlsAcquiredTs,
  type ClearHlsAcquisitionFailure,
  type ClearHlsAcquisitionProgress,
  type FinalizationStep,
} from "./hls-fragment-acquisition.server.ts";

/**
 * HLS-3: sequential clear-HLS MPEG-TS fragment acquisition.
 *
 * Every test runs against synthetic safe-HTTP hooks and a throwaway local
 * workDir: no real DNS, no real socket, no external network and only
 * placeholder hosts. The hooks record every lookup and every request, which is
 * how the load-bearing claims are pinned — ONE logical GET per fragment, one
 * request in flight at a time, zero retries, and no request at all once the
 * operation has been stopped.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE_PATH = join(ROOT, "src/worker/hls/hls-fragment-acquisition.server.ts");
const HLS_DIR = dirname(MODULE_PATH);

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };
const PRIVATE: DnsAnswer = { address: "127.0.0.1", family: 4 };

const F1 = "https://origin.example/media/seg1.ts";
const F2 = "https://origin.example/media/seg2.ts";
const F3 = "https://origin.example/media/seg3.ts";

const AGGREGATE_NAME = "hls-source.ts";
const PARTIAL_NAME = "hls-source.ts.part";

/** The fixed safe-HTTP request profile. Nothing may be added to it. */
const FIXED_PROFILE = {
  "User-Agent": "VideoFetch/1.0",
  Accept: "video/*,audio/*,*/*;q=0.8",
};

/** Directory-permission tricks below are meaningless for a superuser. */
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// ── The throwaway workDir ────────────────────────────────────────────────────

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hls3-"));
});

afterEach(async () => {
  setSafeHttpTestHooks(null);
  setClearHlsFinalizationBarrierForTests(null);
  try {
    chmodSync(workDir, 0o700);
  } catch {
    // The directory may already be gone; the removal below is best effort.
  }
  await rm(workDir, { recursive: true, force: true });
});

function aggregatePath(): string {
  return join(workDir, AGGREGATE_NAME);
}

function partialPath(): string {
  return join(workDir, PARTIAL_NAME);
}

function workDirEntries(): string[] {
  return readdirSync(workDir).sort();
}

// ── Fixture construction ─────────────────────────────────────────────────────

/** A plan shaped exactly the way HLS-2 freezes one. */
function planOf(urls: readonly string[]): ClearHlsAcquisitionPlan {
  return Object.freeze({
    segmentType: "mpegts" as const,
    fragments: Object.freeze(urls.map((url) => Object.freeze({ url }))),
    fragmentCount: urls.length,
  });
}

/** Distinct, recognisable fragment payloads. */
function payload(marker: string, length = 32): Buffer {
  const out = Buffer.alloc(length, marker.charCodeAt(0));
  out.write(marker, 0, "utf8");
  return out;
}

type BodyStats = { pulled: number; destroyed: boolean; ended: boolean };
type TrackedBody = { readonly stream: Readable; readonly stats: BodyStats };

/** A body that records how far it was read and whether it was destroyed. */
function bodyOf(content: Uint8Array, chunkSize = 16): TrackedBody {
  const bytes = Buffer.from(content);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return chunkedBody(chunks);
}

function chunkedBody(chunks: readonly Uint8Array[]): TrackedBody {
  let next = 0;
  const stats: BodyStats = { pulled: 0, destroyed: false, ended: false };
  const stream = new Readable({
    read() {
      const chunk = chunks[next];
      if (chunk === undefined) {
        stats.ended = true;
        this.push(null);
        return;
      }
      next += 1;
      stats.pulled += 1;
      this.push(chunk);
    },
    destroy(err, callback) {
      stats.destroyed = true;
      callback(err);
    },
  });
  return { stream, stats };
}

/**
 * A large body produced on demand, so a 64 MiB fixture never exists as one
 * buffer in the test either. `onBoundary` fires once, when the stream is asked
 * for the chunk that follows the last filler chunk.
 */
function fillerBody(
  chunkCount: number,
  chunkSize: number,
  opts: { readonly extra?: number; readonly onBoundary?: () => void } = {},
): TrackedBody {
  let sent = 0;
  let boundaryFired = false;
  const stats: BodyStats = { pulled: 0, destroyed: false, ended: false };
  const stream = new Readable({
    read() {
      if (sent < chunkCount) {
        sent += 1;
        stats.pulled += 1;
        this.push(Buffer.alloc(chunkSize, 0xab));
        return;
      }
      if (!boundaryFired) {
        boundaryFired = true;
        opts.onBoundary?.();
      }
      if (opts.extra !== undefined && sent === chunkCount) {
        sent += 1;
        stats.pulled += 1;
        this.push(Buffer.alloc(opts.extra, 0xcd));
        return;
      }
      stats.ended = true;
      this.push(null);
    },
    destroy(err, callback) {
      stats.destroyed = true;
      callback(err);
    },
  });
  return { stream, stats };
}

/** A body the test drives by hand; it never ends until told to. */
type ManualBody = {
  readonly stream: Readable;
  readonly stats: BodyStats;
  push(chunk: Uint8Array): void;
  end(): void;
  fail(err: Error): void;
};

function manualBody(): ManualBody {
  const stats: BodyStats = { pulled: 0, destroyed: false, ended: false };
  const stream = new Readable({
    read() {
      // Chunks arrive only when the test pushes them.
    },
    destroy(err, callback) {
      stats.destroyed = true;
      callback(err);
    },
  });
  return {
    stream,
    stats,
    push(chunk) {
      stats.pulled += 1;
      stream.push(chunk);
    },
    end() {
      stats.ended = true;
      stream.push(null);
    },
    fail(err) {
      stream.destroy(err);
    },
  };
}

// ── The synthetic network ────────────────────────────────────────────────────

type RequestArgs = Parameters<SafeRequestOnce>[0];
type Served = {
  readonly status?: number;
  readonly headers?: IncomingHttpHeaders;
  readonly body?: Readable | null;
};
type Route = Served | ((args: RequestArgs) => Served | Promise<Served>);
type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
};
type Network = {
  readonly lookups: string[];
  readonly requests: RecordedRequest[];
  /** The highest number of fragment bodies alive at the same instant. */
  peakLiveBodies(): number;
};

/**
 * Install a synthetic network. Only exact canonical URLs in `routes` answer;
 * anything else is a failed request, and is still recorded.
 */
function fakeNetwork(
  routes: Record<string, Route>,
  opts: {
    readonly dns?: Record<string, DnsAnswer[]>;
    readonly lookup?: (hostname: string) => Promise<DnsAnswer[]>;
  } = {},
): Network {
  const lookups: string[] = [];
  const requests: RecordedRequest[] = [];
  let live = 0;
  let peak = 0;
  setSafeHttpTestHooks({
    lookup: async (hostname) => {
      lookups.push(hostname);
      if (opts.lookup) return opts.lookup(hostname);
      return opts.dns?.[hostname] ?? [PUBLIC];
    },
    requestOnce: async (args) => {
      requests.push({
        url: args.url.href,
        method: args.method,
        headers: { ...args.headers },
        timeoutMs: args.timeoutMs,
      });
      const route = routes[args.url.href];
      if (route === undefined) throw new AppError("NETWORK_ERROR");
      const served = typeof route === "function" ? await route(args) : route;
      const body = served.body === undefined ? null : served.body;
      if (body !== null) {
        live += 1;
        peak = Math.max(peak, live);
        body.on("close", () => {
          live -= 1;
        });
      }
      return { status: served.status ?? 200, headers: served.headers ?? {}, body };
    },
  });
  return { lookups, requests, peakLiveBodies: () => peak };
}

function serve(content: Uint8Array, headers: IncomingHttpHeaders = {}): Served {
  return { status: 200, headers, body: bodyOf(content).stream };
}

function redirect(location: string, status = 302): Served {
  return { status, headers: { location }, body: null };
}

/** A request that only ever settles by being aborted, as a real socket does. */
function neverAnswers(args: RequestArgs): Promise<Served> {
  return new Promise((_, reject) => {
    args.signal?.addEventListener("abort", () => reject(new AppError("NETWORK_ERROR")), {
      once: true,
    });
  });
}

// ── Invocation helpers ───────────────────────────────────────────────────────

type AcquireOptions = {
  readonly workDir?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: ClearHlsAcquisitionProgress) => void;
};

/**
 * The default budget here is a test-harness bound, not the production one: a
 * test that fails while a fragment body is still open would otherwise leave the
 * real 10-minute download budget holding the runner open. The production
 * default is covered explicitly below, through the API directly.
 */
const HARNESS_BUDGET_MS = 10_000;

function acquire(
  plan: ClearHlsAcquisitionPlan,
  opts: AcquireOptions = {},
): Promise<ClearHlsAcquiredTs> {
  return acquireClearHlsTs({
    plan,
    workDir: opts.workDir ?? workDir,
    signal: opts.signal ?? new AbortController().signal,
    timeoutMs: opts.timeoutMs ?? HARNESS_BUDGET_MS,
    onProgress: opts.onProgress,
  });
}

async function refusedWith(
  pending: Promise<unknown>,
  reason: ClearHlsAcquisitionFailure,
): Promise<ClearHlsAcquisitionError> {
  let thrown: unknown;
  try {
    await pending;
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown instanceof ClearHlsAcquisitionError,
    `expected a ClearHlsAcquisitionError, saw ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`,
  );
  assert.equal(thrown.reason, reason);
  return thrown;
}

/** No artifact of any kind survived a failed acquisition. */
function noArtifacts(): void {
  assert.deepEqual(workDirEntries(), [], "a failed acquisition leaves nothing behind");
}

/** Let pending promise jobs and immediates run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

async function waitFor(predicate: () => boolean, label: string, limitMs = 5000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

/** The partial artifact's current size, or -1 while it does not exist. */
function partialSize(): number {
  return existsSync(partialPath()) ? statSync(partialPath()).size : -1;
}

/**
 * Hold the acquisition at ONE finalization step until the test releases it.
 *
 * The acquisition parks INSIDE finalization, so the stop under test lands while
 * a named filesystem await is in flight — no wall-clock luck, and no guessing
 * at where a stop happened to arrive. `steps` records every step the
 * acquisition actually reached, which is how "the rename never began" is
 * proved: `after-rename` sits immediately after the rename call.
 */
type HeldFinalization = {
  /** Every finalization step the acquisition reached, in order. */
  readonly steps: FinalizationStep[];
  /** Resolves once the acquisition is parked at the held step. */
  readonly reached: Promise<void>;
  /** Let the acquisition continue past the held step. */
  release(): void;
};

function holdFinalizationAt(step: FinalizationStep): HeldFinalization {
  const steps: FinalizationStep[] = [];
  let announce: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  setClearHlsFinalizationBarrierForTests(async (at) => {
    steps.push(at);
    if (at !== step) return;
    announce();
    await released;
  });
  return { steps, reached, release };
}

/**
 * Wait out a budget that has already been armed while the acquisition is parked
 * at a barrier. This is not a race: the acquisition cannot advance until the
 * test releases it, so the only question is whether the timer has fired, and
 * waiting several times the budget settles that.
 */
async function letTheDeadlinePass(budgetMs: number): Promise<void> {
  await sleep(budgetMs * 4);
}

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

type MutableConfig = Pick<typeof config, "maxFileSize" | "maxRedirects" | "downloadTimeoutMs">;

/**
 * Narrow a Product limit for ONE test and restore the exact original value.
 * No environment file is touched, and the production ceiling stays real.
 */
async function withConfig<T>(patch: Partial<MutableConfig>, run: () => Promise<T>): Promise<T> {
  const saved: MutableConfig = {
    maxFileSize: config.maxFileSize,
    maxRedirects: config.maxRedirects,
    downloadTimeoutMs: config.downloadTimeoutMs,
  };
  Object.assign(config, patch);
  try {
    return await run();
  } finally {
    Object.assign(config, saved);
  }
}

/** Everything an error could reveal, rendered every way a caller might. */
function renderedError(err: Error): string {
  return [
    err.message,
    err.stack ?? "",
    String(err),
    JSON.stringify(err),
    inspect(err, { depth: 10, showHidden: true }),
  ].join("\n");
}

function leaksNothing(err: Error, ...secrets: readonly string[]): void {
  assert.equal((err as { cause?: unknown }).cause, undefined, "no underlying error is attached");
  const text = renderedError(err);
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `refusal text must not echo ${secret.slice(0, 8)}…`);
  }
}

// ── Positive: exact concatenation (§41) ──────────────────────────────────────

describe("clear-HLS acquisition: one aggregate TS artifact, byte for byte", () => {
  it("writes a single fragment exactly, and reports its verified size", async () => {
    const bytes = payload("A", 96);
    fakeNetwork({ [F1]: serve(bytes) });
    const result = await acquire(planOf([F1]));
    assert.equal(result.segmentType, "mpegts");
    assert.equal(result.filePath, aggregatePath());
    assert.equal(result.fileSize, bytes.length);
    assert.deepEqual(readFileSync(result.filePath), bytes);
    assert.deepEqual(Object.keys(result).sort(), ["filePath", "fileSize", "segmentType"]);
  });

  it("concatenates several fragments in exact plan order with no separator", async () => {
    const a = payload("A", 100);
    const b = payload("B", 7);
    const c = payload("C", 4096);
    fakeNetwork({ [F1]: serve(a), [F2]: serve(b), [F3]: serve(c) });
    const result = await acquire(planOf([F1, F2, F3]));
    const expected = Buffer.concat([a, b, c]);
    assert.equal(result.fileSize, expected.length);
    assert.deepEqual(readFileSync(result.filePath), expected);
  });

  it("appends a duplicated plan position twice, fetching it twice", async () => {
    const a = payload("A", 40);
    const b = payload("B", 40);
    const net = fakeNetwork({ [F1]: () => serve(a), [F2]: () => serve(b) });
    const result = await acquire(planOf([F1, F2, F1]));
    assert.deepEqual(readFileSync(result.filePath), Buffer.concat([a, b, a]));
    assert.deepEqual(net.requests.map((r) => r.url), [F1, F2, F1]);
  });

  it("transforms no byte, whatever the chunk boundaries are", async () => {
    const bytes = Buffer.from([0x47, 0x00, 0xff, 0x0a, 0x0d, 0x1a, 0x00, 0x47, 0x80, 0x7f]);
    fakeNetwork({ [F1]: { status: 200, body: chunkedBody([bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2)]).stream } });
    const result = await acquire(planOf([F1]));
    assert.deepEqual(readFileSync(result.filePath), bytes);
  });

  it("accepts an empty fragment body without inserting anything", async () => {
    const b = payload("B", 8);
    fakeNetwork({ [F1]: { status: 200, body: chunkedBody([]).stream }, [F2]: serve(b) });
    const result = await acquire(planOf([F1, F2]));
    assert.equal(result.fileSize, b.length);
    assert.deepEqual(readFileSync(result.filePath), b);
  });

  it("leaves only the final .ts artifact behind", async () => {
    fakeNetwork({ [F1]: serve(payload("A")), [F2]: serve(payload("B")) });
    await acquire(planOf([F1, F2]));
    assert.deepEqual(workDirEntries(), [AGGREGATE_NAME]);
  });

  it("the verified file size equals the streamed aggregate counter", async () => {
    const a = payload("A", 1234);
    const b = payload("B", 4321);
    fakeNetwork({ [F1]: serve(a), [F2]: serve(b) });
    const result = await acquire(planOf([F1, F2]));
    assert.equal(result.fileSize, statSync(result.filePath).size);
    assert.equal(result.fileSize, a.length + b.length);
  });

  it("consumes a real HLS-2 plan end to end", async () => {
    const playlistUrl = "https://origin.example/media/index.m3u8";
    const a = payload("A", 64);
    const b = payload("B", 64);
    const document = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,",
      "seg1.ts",
      "#EXTINF:10.0,",
      "seg2.ts",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");
    fakeNetwork({
      [playlistUrl]: serve(Buffer.from(document, "utf8")),
      [F1]: serve(a),
      [F2]: serve(b),
    });
    const plan = await preflightClearHlsMediaPlaylist({
      playlistUrl,
      signal: new AbortController().signal,
    });
    assert.deepEqual(plan.fragments.map((f) => f.url), [F1, F2]);
    const result = await acquire(plan);
    assert.deepEqual(readFileSync(result.filePath), Buffer.concat([a, b]));
  });
});

// ── Sequentiality and zero retries (§42, §36, §11) ───────────────────────────

describe("clear-HLS acquisition: one fragment at a time, once each", () => {
  it("does not request fragment 2 while fragment 1's body is incomplete", async () => {
    const first = manualBody();
    const net = fakeNetwork({
      [F1]: { status: 200, body: first.stream },
      [F2]: serve(payload("B", 8)),
    });
    const pending = acquire(planOf([F1, F2]));
    await waitFor(() => net.requests.length === 1, "fragment 1 request");
    first.push(payload("A", 8));
    await settle();
    assert.equal(net.requests.length, 1, "fragment 2 must not start mid-body");
    first.end();
    const result = await pending;
    assert.deepEqual(net.requests.map((r) => r.url), [F1, F2]);
    assert.equal(net.peakLiveBodies(), 1, "at most one fragment body may be alive");
    assert.equal(result.fileSize, 16);
  });

  it("keeps at most one fragment body alive across a long plan", async () => {
    const urls = [F1, F2, F3];
    const net = fakeNetwork(Object.fromEntries(urls.map((u, i) => [u, () => serve(payload(String.fromCharCode(65 + i), 24))])));
    await acquire(planOf(urls));
    assert.equal(net.peakLiveBodies(), 1);
  });

  it("issues exactly one logical GET per fragment and nothing else", async () => {
    const urls = [F1, F2, F3];
    const net = fakeNetwork(Object.fromEntries(urls.map((u) => [u, () => serve(payload("X", 8))])));
    await acquire(planOf(urls));
    assert.equal(net.requests.length, urls.length);
    assert.deepEqual([...new Set(net.requests.map((r) => r.method))], ["GET"]);
    assert.deepEqual(net.lookups, ["origin.example", "origin.example", "origin.example"]);
  });

  it("sends only the fixed safe-HTTP profile, with no caller headers", async () => {
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
    await acquire(planOf([F1]));
    assert.deepEqual(net.requests[0]?.headers, FIXED_PROFILE);
  });

  it("never retries a fragment that failed part-way through its body", async () => {
    const broken = manualBody();
    const net = fakeNetwork({
      [F1]: serve(payload("A", 8)),
      [F2]: { status: 200, body: broken.stream },
      [F3]: serve(payload("C", 8)),
    });
    const pending = acquire(planOf([F1, F2, F3]));
    await waitFor(() => net.requests.length === 2, "fragment 2 request");
    broken.push(payload("B", 8));
    await waitFor(() => existsSync(partialPath()) && partialSize() === 16, "partial bytes");
    broken.fail(new Error("socket reset"));
    await refusedWith(pending, "network_error");
    assert.deepEqual(net.requests.map((r) => r.url), [F1, F2]);
    noArtifacts();
  });
});

// ── Request-time DNS and redirect authority (§43, §12, §13) ──────────────────

describe("clear-HLS acquisition: request-time destination authority", () => {
  it("resolves every fragment at request time, including a repeated host", async () => {
    const net = fakeNetwork({
      [F1]: () => serve(payload("A", 8)),
      ["https://other.example/x.ts"]: () => serve(payload("B", 8)),
    });
    await acquire(planOf([F1, "https://other.example/x.ts", F1]));
    assert.deepEqual(net.lookups, ["origin.example", "other.example", "origin.example"]);
  });

  it("refuses a fragment whose DNS answer is private, after one good fragment", async () => {
    const net = fakeNetwork(
      { [F1]: serve(payload("A", 8)), ["https://evil.example/x.ts"]: serve(payload("B", 8)) },
      { dns: { "evil.example": [PRIVATE] } },
    );
    const err = await refusedWith(
      acquire(planOf([F1, "https://evil.example/x.ts"])),
      "destination_rejected",
    );
    leaksNothing(err, "evil.example", "127.0.0.1");
    assert.deepEqual(net.requests.map((r) => r.url), [F1]);
    noArtifacts();
  });

  it("refuses a redirect whose target resolves privately", async () => {
    const net = fakeNetwork(
      { [F1]: redirect("https://evil.example/x.ts"), ["https://evil.example/x.ts"]: serve(payload("B", 8)) },
      { dns: { "evil.example": [PRIVATE] } },
    );
    await refusedWith(acquire(planOf([F1])), "destination_rejected");
    assert.deepEqual(net.requests.map((r) => r.url), [F1]);
    noArtifacts();
  });

  it("refuses a redirect to a blocked hostname", async () => {
    for (const blocked of ["http://localhost/x.ts", "http://169.254.169.254/x.ts", "http://a.internal/x.ts"]) {
      const net = fakeNetwork({ [F1]: redirect(blocked) });
      await refusedWith(acquire(planOf([F1])), "destination_rejected");
      assert.deepEqual(net.requests.map((r) => r.url), [F1]);
      noArtifacts();
    }
  });

  it("follows a redirect inside ONE logical fragment GET and appends the final body", async () => {
    const a = payload("A", 12);
    const net = fakeNetwork({
      [F1]: redirect("https://cdn.example/final.ts"),
      ["https://cdn.example/final.ts"]: serve(a),
    });
    const result = await acquire(planOf([F1]));
    assert.deepEqual(readFileSync(result.filePath), a);
    assert.deepEqual(net.requests.map((r) => r.url), [F1, "https://cdn.example/final.ts"]);
    assert.deepEqual(net.lookups, ["origin.example", "cdn.example"]);
  });

  it("honours the HLS fragment redirect ceiling and never widens the global one", async () => {
    const hops = (count: number): Record<string, Route> => {
      const routes: Record<string, Route> = {};
      for (let i = 0; i < count; i += 1) {
        routes[`https://h${i}.example/x.ts`] = redirect(`https://h${i + 1}.example/x.ts`);
      }
      routes[`https://h${count}.example/x.ts`] = serve(payload("A", 8));
      return routes;
    };
    // Exactly at the ceiling is fine.
    fakeNetwork(hops(HLS_V1_MAX_FRAGMENT_REDIRECTS));
    assert.equal((await acquire(planOf(["https://h0.example/x.ts"]))).fileSize, 8);
    await rm(aggregatePath());

    // One hop past it is not, even when the application policy is far wider.
    await withConfig({ maxRedirects: 50 }, async () => {
      const net = fakeNetwork(hops(HLS_V1_MAX_FRAGMENT_REDIRECTS + 1));
      await refusedWith(acquire(planOf(["https://h0.example/x.ts"])), "network_error");
      assert.equal(net.requests.length, HLS_V1_MAX_FRAGMENT_REDIRECTS + 1);
      noArtifacts();
    });
  });

  it("narrows to a stricter application redirect policy", async () => {
    await withConfig({ maxRedirects: 1 }, async () => {
      const net = fakeNetwork({
        [F1]: redirect("https://h1.example/x.ts"),
        ["https://h1.example/x.ts"]: redirect("https://h2.example/x.ts"),
        ["https://h2.example/x.ts"]: serve(payload("A", 8)),
      });
      await refusedWith(acquire(planOf([F1])), "network_error");
      assert.equal(net.requests.length, 2);
    });
  });

  it("starts no request from a DNS answer that arrives after cancellation", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const net = fakeNetwork(
      { [F1]: serve(payload("A", 8)) },
      {
        lookup: async () => {
          await gate;
          return [PUBLIC];
        },
      },
    );
    const controller = new AbortController();
    const pending = acquire(planOf([F1]), { signal: controller.signal });
    await waitFor(() => net.lookups.length === 1, "the in-flight lookup");
    controller.abort();
    release();
    await refusedWith(pending, "cancelled");
    assert.equal(net.requests.length, 0, "a late answer must build no request");
    noArtifacts();
  });

  it("starts no request from a DNS answer that arrives after the deadline", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const net = fakeNetwork(
      { [F1]: serve(payload("A", 8)) },
      {
        lookup: async () => {
          await gate;
          return [PUBLIC];
        },
      },
    );
    const pending = acquire(planOf([F1]), { timeoutMs: 40 });
    await waitFor(() => net.lookups.length === 1, "the in-flight lookup");
    await sleep(120);
    release();
    await refusedWith(pending, "timeout");
    assert.equal(net.requests.length, 0);
    noArtifacts();
  });
});

// ── The per-fragment 64 MiB bound (§44, §19) ─────────────────────────────────

describe("clear-HLS acquisition: the per-fragment hard bound", () => {
  it("is exactly 67,108,864 bytes", () => {
    assert.equal(HLS_V1_MAX_FRAGMENT_BYTES, 67_108_864);
    assert.equal(HLS_V1_MAX_FRAGMENT_BYTES, 64 * 1024 * 1024);
  });

  it("refuses a declared oversize fragment before reading any body", async () => {
    const body = manualBody();
    const net = fakeNetwork({
      [F1]: {
        status: 200,
        headers: { "content-length": String(HLS_V1_MAX_FRAGMENT_BYTES + 1) },
        body: body.stream,
      },
    });
    await refusedWith(acquire(planOf([F1])), "fragment_too_large");
    assert.equal(body.stats.pulled, 0, "no body byte may be pulled");
    assert.equal(body.stats.destroyed, true);
    assert.equal(net.requests.length, 1);
    noArtifacts();
  });

  it("accepts a fragment of exactly the ceiling when the total allows it", async () => {
    const mib = 1024 * 1024;
    fakeNetwork({ [F1]: { status: 200, body: fillerBody(64, mib).stream } });
    const result = await acquire(planOf([F1]));
    assert.equal(result.fileSize, HLS_V1_MAX_FRAGMENT_BYTES);
    assert.equal(statSync(result.filePath).size, HLS_V1_MAX_FRAGMENT_BYTES);
  });

  it("refuses an unknown-length body one byte past the ceiling, and cleans up", async () => {
    const mib = 1024 * 1024;
    const body = fillerBody(64, mib, { extra: 1 });
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    await refusedWith(acquire(planOf([F1])), "fragment_too_large");
    assert.equal(body.stats.pulled, 65, "the one extra chunk was delivered and refused");
    assert.equal(body.stats.destroyed, true);
    noArtifacts();
  });

  it("never writes the offending chunk (the bound is checked before the write)", async (t) => {
    if (IS_ROOT) return t.skip("directory permissions do not bind a superuser");
    const mib = 1024 * 1024;
    const body = fillerBody(64, mib, { extra: 4096 });
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    const pending = acquire(planOf([F1]));
    // Break removal so the partial survives its own refusal and can be
    // measured at exactly the instant the offending chunk was rejected.
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    chmodSync(workDir, 0o500);
    try {
      await refusedWith(pending, "fragment_too_large");
      assert.equal(partialSize(), HLS_V1_MAX_FRAGMENT_BYTES, "the refused chunk was never written");
    } finally {
      chmodSync(workDir, 0o700);
    }
  });

  it("treats a small declared length as no licence for a larger body", async () => {
    await withConfig({ maxFileSize: 20 }, async () => {
      // Declared 16, delivered 40: only the streamed counter can notice, and it
      // refuses the chunk that would cross the total.
      fakeNetwork({
        [F1]: {
          status: 200,
          headers: { "content-length": "16" },
          body: chunkedBody([payload("A", 16), payload("B", 24)]).stream,
        },
      });
      await refusedWith(acquire(planOf([F1])), "aggregate_too_large");
      noArtifacts();
    });
  });
});

// ── The aggregate 4 GiB bound (§45, §46, §20, §21) ───────────────────────────

describe("clear-HLS acquisition: the aggregate hard bound", () => {
  it("is exactly 4,294,967,296 bytes, taken from the shared Product limit", () => {
    assert.equal(HLS_V1_MAX_AGGREGATE_BYTES, 4_294_967_296);
    assert.equal(HLS_V1_MAX_AGGREGATE_BYTES, 4 * 1024 * 1024 * 1024);
    assert.equal(HLS_V1_MAX_AGGREGATE_BYTES, DEFAULT_MAX_FILE_SIZE_BYTES);
  });

  it("honours a LOWER operator limit and is never widened by a higher one", async () => {
    await withConfig({ maxFileSize: 1000 }, async () => {
      assert.equal(hlsV1EffectiveAggregateLimitBytes(), 1000);
    });
    await withConfig({ maxFileSize: DEFAULT_MAX_FILE_SIZE_BYTES }, async () => {
      assert.equal(hlsV1EffectiveAggregateLimitBytes(), 4_294_967_296);
    });
    for (const wider of [DEFAULT_MAX_FILE_SIZE_BYTES + 1, 8 * 1024 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      await withConfig({ maxFileSize: wider }, async () => {
        assert.equal(hlsV1EffectiveAggregateLimitBytes(), 4_294_967_296);
      });
    }
    await withConfig({ maxFileSize: Number.POSITIVE_INFINITY }, async () => {
      assert.equal(hlsV1EffectiveAggregateLimitBytes(), 0, "a broken limit fails closed");
    });
  });

  it("accepts a total of exactly the effective ceiling", async () => {
    await withConfig({ maxFileSize: 30 }, async () => {
      fakeNetwork({ [F1]: serve(payload("A", 20)), [F2]: serve(payload("B", 10)) });
      const result = await acquire(planOf([F1, F2]));
      assert.equal(result.fileSize, 30);
    });
  });

  it("refuses one byte past the effective ceiling and keeps no artifact", async () => {
    await withConfig({ maxFileSize: 30 }, async () => {
      const net = fakeNetwork({
        [F1]: serve(payload("A", 20)),
        [F2]: { status: 200, body: chunkedBody([payload("B", 10), payload("C", 1)]).stream },
        [F3]: serve(payload("D", 8)),
      });
      await refusedWith(acquire(planOf([F1, F2, F3])), "aggregate_too_large");
      assert.deepEqual(net.requests.map((r) => r.url), [F1, F2]);
      noArtifacts();
    });
  });

  it("does not reset the aggregate counter between fragments", async () => {
    await withConfig({ maxFileSize: 10 }, async () => {
      // Each fragment fits on its own; only a counter that spans the plan can
      // refuse the pair.
      fakeNetwork({ [F1]: serve(payload("A", 6)), [F2]: serve(payload("B", 6)) });
      await refusedWith(acquire(planOf([F1, F2])), "aggregate_too_large");
      noArtifacts();
    });
  });

  it("does not reset the aggregate counter across a redirect", async () => {
    await withConfig({ maxFileSize: 10 }, async () => {
      fakeNetwork({
        [F1]: serve(payload("A", 6)),
        [F2]: redirect("https://cdn.example/final.ts"),
        ["https://cdn.example/final.ts"]: serve(payload("B", 6)),
      });
      await refusedWith(acquire(planOf([F1, F2])), "aggregate_too_large");
      noArtifacts();
    });
  });

  it("refuses a declared length that fits the fragment but not the remaining total", async () => {
    await withConfig({ maxFileSize: 30 }, async () => {
      const body = manualBody();
      fakeNetwork({
        [F1]: serve(payload("A", 20)),
        [F2]: { status: 200, headers: { "content-length": "11" }, body: body.stream },
      });
      await refusedWith(acquire(planOf([F1, F2])), "aggregate_too_large");
      assert.equal(body.stats.pulled, 0);
      noArtifacts();
    });
  });

  it("never writes the chunk that would pass the total (checked before the write)", async (t) => {
    if (IS_ROOT) return t.skip("directory permissions do not bind a superuser");
    await withConfig({ maxFileSize: 30 }, async () => {
      const body = manualBody();
      fakeNetwork({ [F1]: { status: 200, body: body.stream } });
      const pending = acquire(planOf([F1]));
      await waitFor(() => existsSync(partialPath()), "the partial artifact");
      body.push(payload("A", 30));
      await waitFor(() => partialSize() === 30, "the accepted bytes");
      chmodSync(workDir, 0o500);
      body.push(payload("B", 8));
      try {
        await refusedWith(pending, "aggregate_too_large");
        assert.equal(partialSize(), 30, "the refused chunk was never written");
      } finally {
        chmodSync(workDir, 0o700);
      }
    });
  });

  it("classifies a chunk over BOTH bounds as fragment_too_large", async () => {
    // The same chunk crosses the fragment ceiling and the total at once, so
    // only the precedence rule decides which reason is reported.
    await withConfig({ maxFileSize: HLS_V1_MAX_FRAGMENT_BYTES }, async () => {
      const body = fillerBody(64, 1024 * 1024, { extra: 1 });
      fakeNetwork({ [F1]: { status: 200, body: body.stream } });
      await refusedWith(acquire(planOf([F1])), "fragment_too_large");
      noArtifacts();
    });
  });

  it("uses the same precedence for a declared length over both bounds", async () => {
    await withConfig({ maxFileSize: 1024 }, async () => {
      const body = manualBody();
      fakeNetwork({
        [F1]: {
          status: 200,
          headers: { "content-length": String(HLS_V1_MAX_FRAGMENT_BYTES + 1) },
          body: body.stream,
        },
      });
      await refusedWith(acquire(planOf([F1])), "fragment_too_large");
      assert.equal(body.stats.pulled, 0);
      noArtifacts();
    });
  });
});

// ── Content-Length is completeness, not authority (§26, §47) ─────────────────

describe("clear-HLS acquisition: Content-Length", () => {
  it("accepts a body that matches its declared length", async () => {
    const a = payload("A", 64);
    fakeNetwork({ [F1]: { status: 200, headers: { "content-length": "64" }, body: bodyOf(a).stream } });
    const result = await acquire(planOf([F1]));
    assert.deepEqual(readFileSync(result.filePath), a);
  });

  it("fails a body shorter than its declared length", async () => {
    fakeNetwork({ [F1]: { status: 200, headers: { "content-length": "64" }, body: bodyOf(payload("A", 32)).stream } });
    await refusedWith(acquire(planOf([F1])), "network_error");
    noArtifacts();
  });

  it("fails a body longer than its declared length", async () => {
    fakeNetwork({ [F1]: { status: 200, headers: { "content-length": "32" }, body: bodyOf(payload("A", 64)).stream } });
    await refusedWith(acquire(planOf([F1])), "network_error");
    noArtifacts();
  });

  it("ignores an unparseable declared length and still bounds the body", async () => {
    await withConfig({ maxFileSize: 10 }, async () => {
      for (const declared of ["", "  ", "abc", "-1", "1.5", "12, 12"]) {
        fakeNetwork({ [F1]: { status: 200, headers: { "content-length": declared }, body: bodyOf(payload("A", 16)).stream } });
        await refusedWith(acquire(planOf([F1])), "aggregate_too_large");
        noArtifacts();
      }
    });
  });

  it("accepts a fragment with no declared length at all", async () => {
    const a = payload("A", 48);
    fakeNetwork({ [F1]: { status: 200, body: bodyOf(a).stream } });
    assert.deepEqual(readFileSync((await acquire(planOf([F1]))).filePath), a);
  });
});

// ── Status, encoding and body shape (§15, §16, §39) ──────────────────────────

describe("clear-HLS acquisition: response acceptance", () => {
  it("refuses any status other than exactly 200, including 206", async () => {
    for (const status of [201, 204, 206, 400, 401, 403, 404, 410, 416, 500, 503]) {
      const net = fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: { status, body: bodyOf(payload("B", 8)).stream } });
      await refusedWith(acquire(planOf([F1, F2, F3])), "fragment_http_status");
      assert.deepEqual(net.requests.map((r) => r.url), [F1, F2]);
      noArtifacts();
    }
  });

  it("refuses every content coding but absent and identity", async () => {
    for (const coding of ["gzip", "br", "deflate", "zstd", "compress", "gzip, identity", "IDENTITY;q=1"]) {
      const body = manualBody();
      fakeNetwork({ [F1]: { status: 200, headers: { "content-encoding": coding }, body: body.stream } });
      await refusedWith(acquire(planOf([F1])), "fragment_encoding");
      assert.equal(body.stats.pulled, 0);
      assert.equal(body.stats.destroyed, true);
      noArtifacts();
    }
  });

  it("accepts an explicit identity coding in any case", async () => {
    for (const coding of ["identity", "IDENTITY", " Identity "]) {
      fakeNetwork({ [F1]: { status: 200, headers: { "content-encoding": coding }, body: bodyOf(payload("A", 8)).stream } });
      assert.equal((await acquire(planOf([F1]))).fileSize, 8);
      await rm(aggregatePath());
    }
  });

  it("never rejects a fragment for its Content-Type", async () => {
    for (const type of ["video/mp2t", "application/octet-stream", "binary/octet-stream", "text/html", "application/json"]) {
      fakeNetwork({ [F1]: { status: 200, headers: { "content-type": type }, body: bodyOf(payload("A", 8)).stream } });
      assert.equal((await acquire(planOf([F1]))).fileSize, 8);
      await rm(aggregatePath());
    }
  });

  it("refuses a response with no body", async () => {
    fakeNetwork({ [F1]: { status: 200, body: null } });
    await refusedWith(acquire(planOf([F1])), "network_error");
    noArtifacts();
  });

  it("refuses a body that yields a non-byte chunk", async () => {
    const stream = Readable.from(["not bytes"], { objectMode: true });
    fakeNetwork({ [F1]: { status: 200, body: stream } });
    await refusedWith(acquire(planOf([F1])), "network_error");
    noArtifacts();
  });

  it("refuses a body that errors mid-stream", async () => {
    const body = manualBody();
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    const pending = acquire(planOf([F1]));
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 8));
    await waitFor(() => partialSize() === 8, "the accepted bytes");
    body.fail(new Error("stream reset"));
    const err = await refusedWith(pending, "network_error");
    leaksNothing(err, "stream reset", "origin.example");
    noArtifacts();
  });

  it("refuses a body destroyed without an error rather than calling it complete", async () => {
    const body = manualBody();
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    const pending = acquire(planOf([F1]));
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 8));
    await waitFor(() => partialSize() === 8, "the accepted bytes");
    body.stream.destroy();
    await refusedWith(pending, "network_error");
    noArtifacts();
  });
});

// ── Streaming behaviour (§22, §23) ───────────────────────────────────────────

describe("clear-HLS acquisition: nothing is buffered whole", () => {
  it("writes each chunk before the next one is consumed", async () => {
    const body = manualBody();
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    const pending = acquire(planOf([F1]));
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 100));
    await waitFor(() => partialSize() === 100, "chunk 1 on disk before the fragment ends");
    body.push(payload("B", 50));
    await waitFor(() => partialSize() === 150, "chunk 2 on disk before the fragment ends");
    assert.equal(existsSync(aggregatePath()), false, "the fragment has not completed yet");
    body.end();
    assert.equal((await pending).fileSize, 150);
  });

  it("writes earlier fragments before later ones are requested", async () => {
    const second = manualBody();
    const net = fakeNetwork({
      [F1]: serve(payload("A", 40)),
      [F2]: { status: 200, body: second.stream },
    });
    const pending = acquire(planOf([F1, F2]));
    await waitFor(() => net.requests.length === 2, "fragment 2 request");
    assert.equal(partialSize(), 40, "fragment 1 is already on disk");
    second.push(payload("B", 10));
    second.end();
    assert.equal((await pending).fileSize, 50);
  });

  it("creates no per-fragment file at any point", async () => {
    const second = manualBody();
    fakeNetwork({ [F1]: serve(payload("A", 40)), [F2]: { status: 200, body: second.stream } });
    const pending = acquire(planOf([F1, F2]));
    await waitFor(() => partialSize() === 40, "fragment 1 bytes");
    assert.deepEqual(workDirEntries(), [PARTIAL_NAME], "only the aggregate partial exists");
    second.push(payload("B", 10));
    second.end();
    await pending;
    assert.deepEqual(workDirEntries(), [AGGREGATE_NAME]);
  });
});

// ── Cancellation and the one total deadline (§27, §28, §48) ──────────────────

describe("clear-HLS acquisition: one deadline, one first cause", () => {
  it("does no file or network work for a caller that has already gone", async () => {
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const controller = new AbortController();
    controller.abort();
    await refusedWith(acquire(planOf([F1]), { signal: controller.signal }), "cancelled");
    assert.equal(net.requests.length, 0);
    assert.equal(net.lookups.length, 0);
    noArtifacts();
  });

  it("refuses a budget that is not a positive number before any work", async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
      await refusedWith(acquire(planOf([F1]), { timeoutMs }), "timeout");
      assert.equal(net.requests.length, 0);
      noArtifacts();
    }
  });

  it("disposes the body and deletes the partial when the caller cancels mid-body", async () => {
    const body = manualBody();
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    const controller = new AbortController();
    const pending = acquire(planOf([F1]), { signal: controller.signal });
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 8));
    await waitFor(() => partialSize() === 8, "the accepted bytes");
    controller.abort();
    await refusedWith(pending, "cancelled");
    assert.equal(body.stats.destroyed, true);
    noArtifacts();
  });

  it("starts no next fragment when the caller cancels strictly between fragments", async () => {
    const controller = new AbortController();
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: serve(payload("B", 8)) });
    const pending = acquire(planOf([F1, F2]), {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.progress === 50) controller.abort();
      },
    });
    await refusedWith(pending, "cancelled");
    assert.deepEqual(net.requests.map((r) => r.url), [F1], "fragment 2 never started");
    noArtifacts();
  });

  it("stops the whole plan on the deadline, however many fragments remain", async () => {
    const body = manualBody();
    const net = fakeNetwork({
      [F1]: { status: 200, body: body.stream },
      [F2]: serve(payload("B", 8)),
      [F3]: serve(payload("C", 8)),
    });
    const pending = acquire(planOf([F1, F2, F3]), { timeoutMs: 60 });
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 8));
    await refusedWith(pending, "timeout");
    assert.deepEqual(net.requests.map((r) => r.url), [F1]);
    assert.equal(body.stats.destroyed, true);
    noArtifacts();
  });

  it("stops a fragment whose request never answers", async () => {
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: neverAnswers });
    await refusedWith(acquire(planOf([F1, F2]), { timeoutMs: 60 }), "timeout");
    assert.deepEqual(net.requests.map((r) => r.url), [F1, F2]);
    noArtifacts();
  });

  it("does NOT re-arm the deadline for each fragment", async () => {
    const slow = (marker: string) => async (): Promise<Served> => {
      await sleep(200);
      return serve(payload(marker, 8));
    };
    const net = fakeNetwork({ [F1]: slow("A"), [F2]: slow("B") });
    // One 300 ms budget covers both fragments; a per-fragment budget would not
    // expire at all, because neither fragment alone needs more than 200 ms.
    await refusedWith(acquire(planOf([F1, F2]), { timeoutMs: 300 }), "timeout");
    assert.deepEqual(net.requests.map((r) => r.url), [F1, F2]);
    noArtifacts();
  });

  it("defaults to the configured download budget when none is supplied", async () => {
    await withConfig({ downloadTimeoutMs: 60 }, async () => {
      fakeNetwork({ [F1]: neverAnswers });
      await refusedWith(
        acquireClearHlsTs({
          plan: planOf([F1]),
          workDir,
          signal: new AbortController().signal,
        }),
        "timeout",
      );
      noArtifacts();
    });
  });

  it("caps a caller-supplied budget at the configured download budget", async () => {
    await withConfig({ downloadTimeoutMs: 60 }, async () => {
      fakeNetwork({ [F1]: neverAnswers });
      await refusedWith(acquire(planOf([F1]), { timeoutMs: 60_000 }), "timeout");
    });
  });

  it("reports the caller as the first cause when cancellation wins", async () => {
    fakeNetwork({ [F1]: neverAnswers });
    const controller = new AbortController();
    const pending = acquire(planOf([F1]), { signal: controller.signal, timeoutMs: 5000 });
    await sleep(30);
    controller.abort();
    await refusedWith(pending, "cancelled");
    noArtifacts();
  });

  it("reports the deadline as the first cause when it wins", async () => {
    fakeNetwork({ [F1]: neverAnswers });
    const controller = new AbortController();
    const pending = acquire(planOf([F1]), { signal: controller.signal, timeoutMs: 40 });
    const settled = refusedWith(pending, "timeout");
    await sleep(250);
    controller.abort();
    await settled;
    noArtifacts();
  });

  it("leaves no timer and no listener on the caller's signal", async () => {
    const controller = new AbortController();
    const before = activeTimeouts();
    fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: serve(payload("B", 8)) });
    await acquire(planOf([F1, F2]), { signal: controller.signal, timeoutMs: 30_000 });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.ok(activeTimeouts() <= before, "the deadline timer was cleared");
    await rm(aggregatePath());

    fakeNetwork({ [F1]: { status: 404 } });
    await refusedWith(acquire(planOf([F1]), { signal: controller.signal, timeoutMs: 30_000 }), "fragment_http_status");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.ok(activeTimeouts() <= before, "the deadline timer was cleared on failure too");
  });
});

// ── Failure cleanup (§25, §31, §49) ──────────────────────────────────────────

describe("clear-HLS acquisition: a failure leaves nothing behind", () => {
  const failures: ReadonlyArray<
    readonly [string, ClearHlsAcquisitionFailure, () => Network, () => void]
  > = [
    [
      "an HTTP status",
      "fragment_http_status",
      () => fakeNetwork({ [F1]: serve(payload("A", 24)), [F2]: { status: 503 } }),
      () => {},
    ],
    [
      "a transport failure",
      "network_error",
      () => fakeNetwork({ [F1]: serve(payload("A", 24)) }),
      () => {},
    ],
    [
      "a privately resolving redirect",
      "destination_rejected",
      () =>
        fakeNetwork(
          { [F1]: serve(payload("A", 24)), [F2]: redirect("https://evil.example/x.ts") },
          { dns: { "evil.example": [PRIVATE] } },
        ),
      () => {},
    ],
    [
      "an unsupported coding",
      "fragment_encoding",
      () =>
        fakeNetwork({
          [F1]: serve(payload("A", 24)),
          [F2]: { status: 200, headers: { "content-encoding": "gzip" }, body: manualBody().stream },
        }),
      () => {},
    ],
    [
      "a declared oversize fragment",
      "fragment_too_large",
      () =>
        fakeNetwork({
          [F1]: serve(payload("A", 24)),
          [F2]: {
            status: 200,
            headers: { "content-length": String(HLS_V1_MAX_FRAGMENT_BYTES + 1) },
            body: manualBody().stream,
          },
        }),
      () => {},
    ],
  ];

  for (const [label, reason, install] of failures) {
    it(`rejects, cleans up and starts no later fragment after ${label}`, async () => {
      const net = install();
      await refusedWith(acquire(planOf([F1, F2, F3])), reason);
      assert.equal(existsSync(aggregatePath()), false);
      assert.equal(existsSync(partialPath()), false);
      noArtifacts();
      assert.equal(net.requests.some((r) => r.url === F3), false, "no later fragment was requested");
    });
  }

  it("discards every earlier fragment when a later one fails part-way", async () => {
    const broken = manualBody();
    fakeNetwork({ [F1]: serve(payload("A", 24)), [F2]: { status: 200, body: broken.stream } });
    const pending = acquire(planOf([F1, F2]));
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    broken.push(payload("B", 24));
    await waitFor(() => partialSize() === 48, "both fragments partially on disk");
    broken.fail(new Error("reset"));
    await refusedWith(pending, "network_error");
    noArtifacts();
  });

  it("refuses the aggregate limit and cleans up after several good fragments", async () => {
    await withConfig({ maxFileSize: 50 }, async () => {
      fakeNetwork({
        [F1]: serve(payload("A", 24)),
        [F2]: serve(payload("B", 24)),
        [F3]: serve(payload("C", 24)),
      });
      await refusedWith(acquire(planOf([F1, F2, F3])), "aggregate_too_large");
      noArtifacts();
    });
  });
});

// ── Filesystem safety (§7, §8, §32, §50) ─────────────────────────────────────

describe("clear-HLS acquisition: the output boundary", () => {
  it("refuses when a partial artifact already exists, without touching it", async () => {
    const existing = payload("X", 11);
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(partialPath(), existing);
    await refusedWith(acquire(planOf([F1])), "output_error");
    assert.deepEqual(readFileSync(partialPath()), existing, "the existing partial is untouched");
    assert.equal(net.requests.length, 0);
    assert.deepEqual(workDirEntries(), [PARTIAL_NAME]);
  });

  it("refuses when a final artifact already exists, without replacing it", async () => {
    const existing = payload("X", 13);
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(aggregatePath(), existing);
    await refusedWith(acquire(planOf([F1])), "output_error");
    assert.deepEqual(readFileSync(aggregatePath()), existing, "the existing artifact is untouched");
    assert.equal(net.requests.length, 0);
    assert.deepEqual(workDirEntries(), [AGGREGATE_NAME]);
  });

  it("refuses a workDir that is not an absolute existing directory", async () => {
    for (const bad of ["", "relative/dir", join(workDir, "missing"), join(workDir, "a", "b")]) {
      const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
      await refusedWith(acquire(planOf([F1]), { workDir: bad }), "output_error");
      assert.equal(net.requests.length, 0);
      noArtifacts();
      assert.equal(existsSync(join(workDir, "missing")), false, "no directory was created");
    }
  });

  it("removes only its own partial, never an unrelated file", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(workDir, "unrelated.bin"), payload("U", 5));
    fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: { status: 500 } });
    await refusedWith(acquire(planOf([F1, F2])), "fragment_http_status");
    assert.deepEqual(workDirEntries(), ["unrelated.bin"]);
  });

  it("derives no path component from a fragment URL", async () => {
    const hostile = [
      "https://origin.example/..%2F..%2Fescape.ts?name=pwned.ts&path=/etc/passwd",
      "https://origin.example/dir/%00null.ts#hls-source.ts",
      "https://sub.deep.origin.example/a/b/c/d/e/f/g.ts",
    ];
    fakeNetwork(Object.fromEntries(hostile.map((u) => [u, () => serve(payload("H", 8))])));
    const result = await acquire(planOf(hostile));
    assert.equal(basename(result.filePath), AGGREGATE_NAME);
    assert.equal(resolve(dirname(result.filePath)), resolve(workDir));
    assert.deepEqual(workDirEntries(), [AGGREGATE_NAME]);
  });

  it("creates the artifact with private permissions", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX mode bits only");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const result = await acquire(planOf([F1]));
    assert.equal(statSync(result.filePath).mode & 0o077, 0, "no group or other access");
  });

  it("fails closed, with no artifact, when the partial cannot be finalized", async (t) => {
    if (IS_ROOT) return t.skip("directory permissions do not bind a superuser");
    const body = manualBody();
    fakeNetwork({ [F1]: { status: 200, body: body.stream } });
    const seen: number[] = [];
    const pending = acquire(planOf([F1]), { onProgress: (p) => seen.push(p.progress) });
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 8));
    await waitFor(() => partialSize() === 8, "the accepted bytes");
    chmodSync(workDir, 0o500);
    body.end();
    try {
      await refusedWith(pending, "output_error");
      assert.equal(existsSync(aggregatePath()), false, "no final artifact was produced");
      assert.equal(
        seen.includes(100),
        false,
        "an acquisition that never finalized never reported 100",
      );
    } finally {
      chmodSync(workDir, 0o700);
    }
  });
});

// ── Plan integrity (§35, §51) ────────────────────────────────────────────────

describe("clear-HLS acquisition: a forged plan never reaches the network", () => {
  const longUrl = `https://origin.example/${"a".repeat(HLS_V1_MAX_FRAGMENT_URL_BYTES)}.ts`;

  const forged: ReadonlyArray<readonly [string, unknown]> = [
    ["a missing plan", undefined],
    ["a null plan", null],
    ["a non-object plan", "mpegts"],
    [
      "the wrong segment type",
      Object.freeze({
        segmentType: "fmp4",
        fragments: Object.freeze([Object.freeze({ url: F1 })]),
        fragmentCount: 1,
      }),
    ],
    [
      "an empty plan",
      Object.freeze({ segmentType: "mpegts", fragments: Object.freeze([]), fragmentCount: 0 }),
    ],
    [
      "a count past the HLS-1 ceiling",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: F1 })]),
        fragmentCount: HLS_V1_MAX_FRAGMENTS + 1,
      }),
    ],
    [
      "a count that disagrees with the array",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: F1 })]),
        fragmentCount: 2,
      }),
    ],
    [
      "a fractional count",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: F1 })]),
        fragmentCount: 1.5,
      }),
    ],
    [
      "a non-string URL",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: new URL(F1) })]),
        fragmentCount: 1,
      }),
    ],
    [
      "an empty URL",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: "" })]),
        fragmentCount: 1,
      }),
    ],
    [
      "an overlong URL",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: longUrl })]),
        fragmentCount: 1,
      }),
    ],
    [
      "a fragment entry carrying extra fields",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: F1, headers: { Cookie: "s=1" } })]),
        fragmentCount: 1,
      }),
    ],
    [
      "an unfrozen plan",
      {
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: F1 })]),
        fragmentCount: 1,
      },
    ],
    [
      "an unfrozen fragment array",
      Object.freeze({
        segmentType: "mpegts",
        fragments: [Object.freeze({ url: F1 })],
        fragmentCount: 1,
      }),
    ],
    [
      "one unfrozen fragment entry",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([Object.freeze({ url: F1 }), { url: F2 }]),
        fragmentCount: 2,
      }),
    ],
    [
      "a null fragment entry",
      Object.freeze({
        segmentType: "mpegts",
        fragments: Object.freeze([null]),
        fragmentCount: 1,
      }),
    ],
  ];

  for (const [label, plan] of forged) {
    it(`refuses ${label} before any network or filesystem work`, async () => {
      const net = fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: serve(payload("B", 8)) });
      await refusedWith(acquire(plan as ClearHlsAcquisitionPlan), "invalid_plan");
      assert.equal(net.requests.length, 0);
      assert.equal(net.lookups.length, 0);
      noArtifacts();
    });
  }

  it("accepts a plan at exactly the resolved-URL ceiling", async () => {
    const maxUrl = `https://origin.example/${"a".repeat(HLS_V1_MAX_FRAGMENT_URL_BYTES - "https://origin.example/".length - 3)}.ts`;
    assert.equal(Buffer.byteLength(maxUrl, "utf8"), HLS_V1_MAX_FRAGMENT_URL_BYTES);
    fakeNetwork({ [maxUrl]: serve(payload("A", 8)) });
    assert.equal((await acquire(planOf([maxUrl]))).fileSize, 8);
  });
});

// ── Progress (§37, §52) ──────────────────────────────────────────────────────

describe("clear-HLS acquisition: truthful fragment-count progress", () => {
  it("reports 0, then one report per completed fragment, ending at 100", async () => {
    const a = payload("A", 10);
    const b = payload("B", 20);
    const c = payload("C", 30);
    fakeNetwork({ [F1]: serve(a), [F2]: serve(b), [F3]: serve(c) });
    const seen: ClearHlsAcquisitionProgress[] = [];
    await acquire(planOf([F1, F2, F3]), { onProgress: (p) => seen.push(p) });
    assert.deepEqual(
      seen.map((p) => [p.progress, p.downloadedBytes]),
      [
        [0, 0],
        [33, 10],
        [67, 30],
        [100, 60],
      ],
    );
    for (const p of seen) {
      assert.equal(p.totalBytes, null);
      assert.equal(p.speed, null);
      assert.equal(p.eta, null);
      assert.equal(p.stage, "downloading");
      assert.ok(p.progress >= 0 && p.progress <= 100);
    }
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]!.progress >= seen[i - 1]!.progress, "progress is monotonic");
      assert.ok(seen[i]!.downloadedBytes >= seen[i - 1]!.downloadedBytes);
    }
  });

  it("never reports a fragment complete before its whole body was written", async () => {
    const body = manualBody();
    fakeNetwork({ [F1]: { status: 200, body: body.stream }, [F2]: serve(payload("B", 4)) });
    const seen: number[] = [];
    const pending = acquire(planOf([F1, F2]), { onProgress: (p) => seen.push(p.progress) });
    await waitFor(() => existsSync(partialPath()), "the partial artifact");
    body.push(payload("A", 4));
    await waitFor(() => partialSize() === 4, "the accepted bytes");
    assert.deepEqual(seen, [0], "a partially transferred fragment is not complete");
    body.end();
    await pending;
    assert.deepEqual(seen, [0, 50, 100]);
  });

  it("emits no success report once the acquisition has failed", async () => {
    fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: { status: 500 }, [F3]: serve(payload("C", 8)) });
    const seen: number[] = [];
    await refusedWith(
      acquire(planOf([F1, F2, F3]), { onProgress: (p) => seen.push(p.progress) }),
      "fragment_http_status",
    );
    assert.deepEqual(seen, [0, 33]);
    assert.equal(seen.includes(100), false);
  });

  it("works without a progress reporter at all", async () => {
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    assert.equal((await acquire(planOf([F1]))).fileSize, 8);
  });
});

// ── Finalization is inside the deadline ──────────────────────────────────────

describe("clear-HLS acquisition: cancellation and the deadline own finalization too", () => {
  it("stops a caller cancellation that lands during the final no-clobber check", async () => {
    const caller = new AbortController();
    const held = holdFinalizationAt("before-rename");
    const net = fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const seen: number[] = [];
    const pending = acquire(planOf([F1]), {
      signal: caller.signal,
      onProgress: (p) => seen.push(p.progress),
    });

    await held.reached;
    assert.equal(partialSize(), 8, "every fragment byte reached the partial");
    assert.equal(existsSync(aggregatePath()), false, "the rename has not begun");

    caller.abort();
    held.release();

    await refusedWith(pending, "cancelled");
    assert.deepEqual(held.steps, ["before-rename"], "the rename never began");
    noArtifacts();
    assert.deepEqual(seen, [0], "a stopped acquisition never reports 100");
    assert.equal(net.requests.length, 1, "no request followed the stop");
  });

  it("stops a deadline that lands while the rename is in flight, and removes the artifact", async () => {
    const held = holdFinalizationAt("after-rename");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const seen: number[] = [];
    const pending = acquire(planOf([F1]), {
      timeoutMs: 50,
      onProgress: (p) => seen.push(p.progress),
    });

    await held.reached;
    assert.equal(existsSync(aggregatePath()), true, "the rename completed");
    assert.equal(existsSync(partialPath()), false, "the partial was renamed away");

    await letTheDeadlinePass(50);
    held.release();

    await refusedWith(pending, "timeout");
    assert.deepEqual(held.steps, ["before-rename", "after-rename"], "nothing ran past the stop");
    noArtifacts();
    assert.deepEqual(seen, [0], "a stopped acquisition never reports 100");
  });

  it("stops a deadline that lands while the final size check is in flight", async () => {
    const held = holdFinalizationAt("before-return");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const seen: number[] = [];
    const pending = acquire(planOf([F1]), {
      timeoutMs: 50,
      onProgress: (p) => seen.push(p.progress),
    });

    await held.reached;
    assert.equal(statSync(aggregatePath()).size, 8, "the artifact was finalized and measured");

    await letTheDeadlinePass(50);
    held.release();

    await refusedWith(pending, "timeout");
    assert.deepEqual(held.steps, ["before-rename", "after-rename", "before-return"]);
    noArtifacts();
    assert.deepEqual(seen, [0], "a verified-but-stopped acquisition still reports no 100");
  });

  it("removes the final artifact when the caller cancels after the rename", async () => {
    const caller = new AbortController();
    const held = holdFinalizationAt("after-rename");
    fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: serve(payload("B", 8)) });
    const seen: number[] = [];
    const pending = acquire(planOf([F1, F2]), {
      signal: caller.signal,
      onProgress: (p) => seen.push(p.progress),
    });

    await held.reached;
    assert.equal(statSync(aggregatePath()).size, 16, "both fragments were finalized");

    caller.abort();
    held.release();

    await refusedWith(pending, "cancelled");
    assert.equal(existsSync(aggregatePath()), false, "the finalized artifact was removed");
    assert.equal(existsSync(partialPath()), false, "no partial survived either");
    noArtifacts();
    assert.deepEqual(seen, [0, 50], "the last fragment's 100 was never emitted");
  });

  it("keeps the caller as the first cause even when the deadline follows in finalization", async () => {
    const caller = new AbortController();
    const held = holdFinalizationAt("after-rename");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const pending = acquire(planOf([F1]), { signal: caller.signal, timeoutMs: 50 });

    await held.reached;
    caller.abort();
    await letTheDeadlinePass(50);
    held.release();

    await refusedWith(pending, "cancelled");
    noArtifacts();
  });

  it("keeps the deadline as the first cause even when the caller follows in finalization", async () => {
    const caller = new AbortController();
    const held = holdFinalizationAt("after-rename");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const pending = acquire(planOf([F1]), { signal: caller.signal, timeoutMs: 50 });

    await held.reached;
    await letTheDeadlinePass(50);
    caller.abort();
    held.release();

    await refusedWith(pending, "timeout");
    noArtifacts();
  });

  it("fails closed, with no artifact and no 100, when post-rename verification disagrees", async () => {
    const held = holdFinalizationAt("after-rename");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const seen: number[] = [];
    const pending = acquire(planOf([F1]), { onProgress: (p) => seen.push(p.progress) });

    await held.reached;
    // Something other than this acquisition changed the finalized artifact.
    truncateSync(aggregatePath(), 4);
    held.release();

    await refusedWith(pending, "output_error");
    noArtifacts();
    assert.deepEqual(seen, [0], "a size that does not verify is not a success");
  });

  it("leaves no timer and no listener when a stop lands in finalization", async () => {
    const caller = new AbortController();
    const before = activeTimeouts();
    const held = holdFinalizationAt("after-rename");
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const pending = acquire(planOf([F1]), { signal: caller.signal, timeoutMs: 50 });

    await held.reached;
    caller.abort();
    held.release();

    await refusedWith(pending, "cancelled");
    await settle();
    assert.equal(activeTimeouts(), before, "the deadline timer was cleared");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0, "no listener was left");
  });

  it("finalizes normally, and reports 100 exactly once, with no barrier installed", async () => {
    setClearHlsFinalizationBarrierForTests(null);
    fakeNetwork({ [F1]: serve(payload("A", 8)), [F2]: serve(payload("B", 8)) });
    const seen: number[] = [];
    const result = await acquire(planOf([F1, F2]), { onProgress: (p) => seen.push(p.progress) });
    assert.equal(result.fileSize, 16);
    assert.deepEqual(seen, [0, 50, 100]);
    assert.deepEqual(workDirEntries(), [AGGREGATE_NAME]);
  });

  it("reports 100 only after the artifact exists at its final name and verified size", async () => {
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const observed: Array<{ progress: number; finalized: boolean; size: number }> = [];
    await acquire(planOf([F1]), {
      onProgress: (p) =>
        observed.push({
          progress: p.progress,
          finalized: existsSync(aggregatePath()),
          size: existsSync(aggregatePath()) ? statSync(aggregatePath()).size : -1,
        }),
    });
    const terminal = observed.filter((row) => row.progress === 100);
    assert.equal(terminal.length, 1, "exactly one terminal report");
    assert.equal(terminal[0]!.finalized, true, "the final artifact already existed");
    assert.equal(terminal[0]!.size, 8, "at its verified size");
  });
});

// ── The private error vocabulary (§34) ───────────────────────────────────────

describe("clear-HLS acquisition: refusals reveal nothing", () => {
  const SECRETS = ["origin.example", "evil.example", "SIGNEDTOKEN", "127.0.0.1", "socket reset"];

  it("carries only a closed reason and a fixed message", async () => {
    const signed = "https://origin.example/seg.ts?Signature=SIGNEDTOKEN";
    fakeNetwork({ [signed]: { status: 451 } });
    const err = await refusedWith(acquire(planOf([signed])), "fragment_http_status");
    assert.deepEqual(Object.keys(err).sort(), ["name", "reason"]);
    assert.equal(err.name, "ClearHlsAcquisitionError");
    leaksNothing(err, ...SECRETS);
  });

  it("names no filesystem path of its own in a local output failure", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(aggregatePath(), payload("X", 4));
    fakeNetwork({ [F1]: serve(payload("A", 8)) });
    const err = await refusedWith(acquire(planOf([F1])), "output_error");
    leaksNothing(err, workDir, AGGREGATE_NAME, PARTIAL_NAME);
  });

  it("keeps the same message for the same reason, whatever produced it", async () => {
    fakeNetwork({ [F1]: { status: 500 } });
    const a = await refusedWith(acquire(planOf([F1])), "fragment_http_status");
    fakeNetwork({ [F2]: { status: 404 } });
    const b = await refusedWith(acquire(planOf([F2])), "fragment_http_status");
    assert.equal(a.message, b.message);
  });
});

// ── Dormancy and the module boundary (§3, §54, §55, §57) ─────────────────────

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

describe("clear-HLS acquisition: dormant, and inside its boundary", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  /** The module with its prose removed, so a mention is not mistaken for a call. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export async function acquireClearHlsTs"));
    assert.equal(code.includes("Dormancy"), false, "comments should be gone");
  });

  it("leaves HLS unadvertised: both protocol policies are still exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("is reachable from no production module outside the dormant HLS directory", () => {
    for (const file of productionSourceFiles()) {
      if (dirname(file) === HLS_DIR) continue;
      assert.equal(
        readFileSync(file, "utf8").includes("hls-fragment-acquisition"),
        false,
        `${relative(ROOT, file)} must not import the dormant HLS acquisition`,
      );
    }
  });

  it("imports only safe-HTTP, config, errors, the shared limit, Node primitives and HLS-1/HLS-2", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [
      "node:buffer",
      "node:fs/promises",
      "node:path",
      "@/lib/config",
      "@/lib/errors",
      "@/lib/security/safe-http.server",
      "@/shared/media-limits",
      "./hls-media-playlist.ts",
      "./hls-preflight.server.ts",
    ]);
  });

  it("makes every fragment request through safeGet, and nothing else", () => {
    assert.equal(code.split("safeGet(").length - 1, 1, "exactly one call site");
    for (const forbidden of [
      "safeHttpRequest",
      "safeHead",
      "resolveSafeDestination",
      "assertSafeUrl",
      "lookupHost",
      "setSafeHttpTestHooks",
      "fetch(",
      "XMLHttpRequest",
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "node:tls",
      "node:dgram",
    ]) {
      assert.equal(code.includes(forbidden), false, `the acquisition must not reference ${forbidden}`);
    }
  });

  it("performs no local media processing whatsoever", () => {
    for (const forbidden of [
      "node:child_process",
      "node:worker_threads",
      "child_process",
      "spawn",
      "execFile",
      "exec(",
      "ffmpeg",
      "ffprobe",
      "yt-dlp",
      "ytdlp",
      "yt_dlp",
      "ProcessRunner",
      "runProcess",
      "require(",
      "import(",
      "process.env",
      "console.",
    ]) {
      assert.equal(code.includes(forbidden), false, `the acquisition must not reference ${forbidden}`);
    }
  });

  it("buffers no fragment and creates no per-fragment file", () => {
    for (const forbidden of [
      "Buffer.concat",
      "toArray(",
      "arrayBuffer(",
      "readFile",
      "createWriteStream",
      "createReadStream",
      "pipeline(",
      "mkdir",
      "mkdtemp",
      "appendFile",
      "writeFile",
    ]) {
      assert.equal(code.includes(forbidden), false, `the acquisition must not reference ${forbidden}`);
    }
    assert.equal(code.split("await handle.write(").length - 1, 1, "one awaited write path");
  });

  it("checks both hard bounds BEFORE the chunk is written", () => {
    const loop = code.slice(code.indexOf("for await (const chunk of"));
    const admit = loop.indexOf("admitBytes(");
    const write = loop.indexOf("writeAll(handle");
    assert.ok(admit >= 0, "the chunk loop admits bytes through the bound check");
    assert.ok(write >= 0, "the chunk loop writes through writeAll");
    assert.ok(admit < write, "the bound check must precede the write");
  });

  it("gates the acquisition immediately after every finalization await", () => {
    const steps: FinalizationStep[] = ["before-rename", "after-rename", "before-return"];
    for (const step of steps) {
      const call = `atFinalizationStep("${step}")`;
      const at = code.indexOf(call);
      assert.ok(at > 0, `${step} must be a real finalization step`);
      const after = code.slice(at + call.length).replace(/\s+/g, " ").trimStart();
      assert.ok(
        after.startsWith("; controller.signal.throwIfAborted();"),
        `${step} must be followed immediately by a stop gate, saw ${after.slice(0, 60)}`,
      );
    }
  });

  it("keeps the finalization barrier inert and reachable only from its setter", () => {
    assert.ok(
      code.includes("let finalizationBarrier: ((step: FinalizationStep) => Promise<void>) | null = null"),
      "the barrier ships null",
    );
    assert.equal(
      code.split("finalizationBarrier").length - 1,
      4,
      "declared, assigned by the test-only setter, null-checked and called — nothing else",
    );
    assert.equal(
      code.split("setClearHlsFinalizationBarrierForTests").length - 1,
      1,
      "the module never installs a barrier on itself",
    );
  });

  it("emits terminal progress only after the last stop gate, with nothing async between", () => {
    const gate = code.lastIndexOf("controller.signal.throwIfAborted();");
    const terminal = code.indexOf("report(onProgress, plan.fragmentCount");
    const returned = code.indexOf("return Object.freeze({");
    assert.ok(gate > 0 && terminal > gate, "the terminal report follows the final gate");
    assert.ok(returned > terminal, "the result follows the terminal report");
    assert.equal(
      code.slice(gate, returned).includes("await "),
      false,
      "no asynchronous work may separate the final gate from the successful return",
    );
  });

  it("never reports 100 from inside the transfer loop", () => {
    const loop = code.slice(
      code.indexOf("for (const fragment of plan.fragments)"),
      code.indexOf("return aggregateBytes;"),
    );
    assert.ok(loop.includes("report(onProgress"), "the loop still reports completed fragments");
    assert.ok(
      loop.includes("if (completed < plan.fragmentCount)"),
      "the last fragment's report is withheld for finalization",
    );
  });

  it("arms exactly one deadline for the whole acquisition", () => {
    assert.equal(code.split("setTimeout(").length - 1, 1);
    assert.equal(code.split("clearTimeout(").length - 1, 1);
    assert.equal(code.split("new AbortController(").length - 1, 1);
  });

  it("accepts no caller-supplied request headers", () => {
    for (const forbidden of ["Cookie", "Authorization", "Proxy-Authorization", "Referer", "User-Agent", "http_headers", "impersonate"]) {
      assert.equal(code.includes(forbidden), false, `the acquisition must not set ${forbidden}`);
    }
  });

  it("uses fixed application-owned artifact names", () => {
    assert.ok(code.includes('const AGGREGATE_FILE_NAME = "hls-source.ts"'));
    assert.ok(code.includes('const PARTIAL_FILE_NAME = "hls-source.ts.part"'));
    assert.equal(code.split("join(").length - 1, 2, "both names are joined onto the workDir only");
  });

  it("lives in the Worker-private HLS directory as a server module", () => {
    const rel = relative(ROOT, MODULE_PATH).split("\\").join("/");
    assert.equal(rel, "src/worker/hls/hls-fragment-acquisition.server.ts");
  });
});
