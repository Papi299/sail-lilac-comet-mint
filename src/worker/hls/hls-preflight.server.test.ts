import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
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
import { YTDLP_V1_NATIVE_PROTOCOLS } from "../analysis/ytdlp-analysis.server.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../execution/generic-source.ts";
import {
  HLS_V1_MAX_FRAGMENTS,
  HLS_V1_MAX_PLAYLIST_BYTES,
} from "./hls-media-playlist.ts";
import {
  ClearHlsPreflightError,
  HLS_V1_MAX_FRAGMENT_URL_BYTES,
  HLS_V1_MAX_PLAYLIST_REDIRECTS,
  preflightClearHlsMediaPlaylist,
  type ClearHlsAcquisitionPlan,
  type ClearHlsPreflightFailure,
  type ClearHlsPreflightRequest,
} from "./hls-preflight.server.ts";

/**
 * HLS-2: bounded playlist preflight and the private immutable acquisition plan.
 *
 * Every test runs against synthetic safe-HTTP hooks: no real DNS, no real
 * socket, and only placeholder hosts. The hooks record every lookup and every
 * request, which is how the load-bearing claims are pinned — ONE logical
 * playlist request, and zero fragment I/O of any kind.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE_PATH = join(ROOT, "src/worker/hls/hls-preflight.server.ts");
const HLS_DIR = dirname(MODULE_PATH);

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };
const PLAYLIST_URL = "https://origin.example/media/index.m3u8";

/** The fixed safe-HTTP request profile. Nothing may be added to it. */
const FIXED_PROFILE = {
  "User-Agent": "VideoFetch/1.0",
  Accept: "video/*,audio/*,*/*;q=0.8",
};

afterEach(() => {
  setSafeHttpTestHooks(null);
});

// ── Fixture construction ─────────────────────────────────────────────────────

/** A minimal valid clear VOD TS playlist with one EXTINF per reference. */
function playlist(
  references: readonly string[],
  opts: { readonly extra?: readonly string[]; readonly title?: string } = {},
): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    ...(opts.extra ?? []),
  ];
  for (const reference of references) {
    lines.push(`#EXTINF:10.0,${opts.title ?? ""}`);
    lines.push(reference);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/**
 * A valid playlist of exactly `bytes` UTF-8 bytes. The padding is a comment
 * INSIDE the document, because only blank lines may follow the terminator.
 */
function playlistOfSize(bytes: number): string {
  const base = playlist(["seg0.ts"]);
  const padding = bytes - Buffer.byteLength(base, "utf8") - 2;
  const source = playlist(["seg0.ts"], { extra: [`#${"p".repeat(padding)}`] });
  assert.equal(Buffer.byteLength(source, "utf8"), bytes);
  return source;
}

type BodyStats = { pulled: number; destroyed: boolean; ended: boolean };
type TrackedBody = { readonly stream: Readable; readonly stats: BodyStats };

/**
 * A response body that records how far it was read and whether it was
 * destroyed. `stallAfter` stops producing after that many chunks without ever
 * ending, like an origin that goes quiet mid-body.
 */
function trackedBody(
  chunks: readonly Uint8Array[],
  opts: { readonly stallAfter?: number } = {},
): TrackedBody {
  const stats: BodyStats = { pulled: 0, destroyed: false, ended: false };
  let next = 0;
  const stream = new Readable({
    read() {
      if (opts.stallAfter !== undefined && next >= opts.stallAfter) return;
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

function bodyOf(content: string | Uint8Array, chunkSize = 64 * 1024): TrackedBody {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return trackedBody(chunks);
}

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
  readonly signal: AbortSignal | undefined;
};

/**
 * Install a synthetic network. Only exact canonical URLs in `routes` answer;
 * anything else is a failed request, and is still recorded.
 */
function fakeNetwork(
  routes: Record<string, Route>,
  dns: Record<string, DnsAnswer[]> = {},
): { readonly lookups: string[]; readonly requests: RecordedRequest[] } {
  const lookups: string[] = [];
  const requests: RecordedRequest[] = [];
  setSafeHttpTestHooks({
    lookup: async (hostname) => {
      lookups.push(hostname);
      return dns[hostname] ?? [PUBLIC];
    },
    requestOnce: async (args) => {
      requests.push({
        url: args.url.href,
        method: args.method,
        headers: { ...args.headers },
        timeoutMs: args.timeoutMs,
        signal: args.signal,
      });
      const route = routes[args.url.href];
      if (route === undefined) throw new Error("unrouted synthetic request");
      const served = typeof route === "function" ? await route(args) : route;
      return {
        status: served.status ?? 200,
        headers: served.headers ?? {},
        body: served.body === undefined ? null : served.body,
      };
    },
  });
  return { lookups, requests };
}

function serve(content: string | Uint8Array, headers: IncomingHttpHeaders = {}): Served {
  return { status: 200, headers, body: bodyOf(content).stream };
}

function redirect(location: string, status = 302): Served {
  return { status, headers: { location }, body: null };
}

function preflight(
  playlistUrl: string = PLAYLIST_URL,
  opts: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<ClearHlsAcquisitionPlan> {
  return preflightClearHlsMediaPlaylist({
    playlistUrl,
    signal: opts.signal ?? new AbortController().signal,
    timeoutMs: opts.timeoutMs,
  });
}

function urls(plan: ClearHlsAcquisitionPlan): string[] {
  return plan.fragments.map((f) => f.url);
}

/** Assert the preflight refuses with exactly `reason`, and return the error. */
async function refusedWith(
  pending: Promise<unknown>,
  reason: ClearHlsPreflightFailure,
): Promise<ClearHlsPreflightError> {
  let thrown: unknown;
  try {
    await pending;
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown instanceof ClearHlsPreflightError,
    `expected a ClearHlsPreflightError, saw ${thrown instanceof Error ? thrown.name : typeof thrown}`,
  );
  assert.equal(thrown.reason, reason);
  return thrown;
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
    assert.equal(text.includes(secret), false, `refusal text must not echo ${secret.slice(0, 6)}…`);
  }
}

/** Let pending promise jobs and immediates run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

async function withConfig<T>(
  patch: Partial<Pick<typeof config, "maxRedirects" | "analysisTimeoutMs">>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = { maxRedirects: config.maxRedirects, analysisTimeoutMs: config.analysisTimeoutMs };
  Object.assign(config, patch);
  try {
    return await run();
  } finally {
    Object.assign(config, saved);
  }
}

// ── Positive: the approved path (§33) ────────────────────────────────────────

describe("clear-HLS preflight: a valid playlist becomes an immutable plan", () => {
  it("resolves a simple valid playlist into the closed plan model", async () => {
    fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["seg0.ts", "seg1.ts"])) });
    const plan = await preflight();
    assert.equal(plan.segmentType, "mpegts");
    assert.equal(plan.fragmentCount, 2);
    assert.deepEqual(urls(plan), [
      "https://origin.example/media/seg0.ts",
      "https://origin.example/media/seg1.ts",
    ]);
    assert.deepEqual(Object.keys(plan).sort(), ["fragmentCount", "fragments", "segmentType"]);
    for (const fragment of plan.fragments) assert.deepEqual(Object.keys(fragment), ["url"]);
  });

  it("resolves relative references against the playlist URL's directory", async () => {
    fakeNetwork({
      [PLAYLIST_URL]: serve(playlist(["seg.ts", "./dot.ts", "sub/dir/seg.ts", "../up/seg.ts"])),
    });
    assert.deepEqual(urls(await preflight()), [
      "https://origin.example/media/seg.ts",
      "https://origin.example/media/dot.ts",
      "https://origin.example/media/sub/dir/seg.ts",
      "https://origin.example/up/seg.ts",
    ]);
  });

  it("resolves against the FINAL redirected URL, never the requested one", async () => {
    const requested = "https://example.test/original/index.m3u8";
    const final = "https://cdn.example/media/v1/index.m3u8";
    const net = fakeNetwork({
      [requested]: redirect(final),
      [final]: serve(playlist(["seg001.ts", "../v2/seg002.ts", "/root/seg003.ts"])),
    });
    const plan = await preflight(requested);
    assert.deepEqual(urls(plan), [
      "https://cdn.example/media/v1/seg001.ts",
      "https://cdn.example/media/v2/seg002.ts",
      "https://cdn.example/root/seg003.ts",
    ]);
    assert.equal(urls(plan).some((u) => u.includes("example.test")), false);
    assert.deepEqual(net.requests.map((r) => r.url), [requested, final]);
  });

  it("uses the last hop of a multi-hop chain, including a relative Location", async () => {
    const hop1 = "https://hop.example/a/index.m3u8";
    const final = "https://hop.example/b/c/index.m3u8";
    fakeNetwork({
      [PLAYLIST_URL]: redirect(hop1, 301),
      [hop1]: redirect("../b/c/index.m3u8", 307),
      [final]: serve(playlist(["seg.ts"])),
    });
    assert.deepEqual(urls(await preflight()), ["https://hop.example/b/c/seg.ts"]);
  });

  const referenceCases: readonly (readonly [string, string, string])[] = [
    ["an absolute HTTP fragment", "http://media.example/a.ts", "http://media.example/a.ts"],
    ["an absolute HTTPS fragment", "https://media.example/b.ts", "https://media.example/b.ts"],
    ["a root-relative fragment", "/root/seg.ts", "https://origin.example/root/seg.ts"],
    ["a scheme-relative fragment", "//other.example/seg.ts", "https://other.example/seg.ts"],
    ["a query-bearing fragment", "seg.ts?start=1&end=2", "https://origin.example/media/seg.ts?start=1&end=2"],
    [
      "a signed-looking absolute fragment",
      "https://cdn.example/seg5.ts?Expires=1758240000&Signature=abc~def_-&Key-Pair-Id=K123",
      "https://cdn.example/seg5.ts?Expires=1758240000&Signature=abc~def_-&Key-Pair-Id=K123",
    ],
    [
      "a signed-looking relative fragment",
      "seg6.ts?token=a%2Fb%2Bc%3D&sig=Zz09",
      "https://origin.example/media/seg6.ts?token=a%2Fb%2Bc%3D&sig=Zz09",
    ],
    ["a public IPv6 literal fragment", "http://[2606:4700::1111]/s.ts", "http://[2606:4700::1111]/s.ts"],
  ];
  for (const [label, reference, expected] of referenceCases) {
    it(`resolves ${label}`, async () => {
      fakeNetwork({ [PLAYLIST_URL]: serve(playlist([reference])) });
      assert.deepEqual(urls(await preflight()), [expected]);
    });
  }

  it("inherits the FINAL URL's scheme for a scheme-relative reference", async () => {
    const httpPlaylist = "http://plain.example/list.m3u8";
    fakeNetwork({ [httpPlaylist]: serve(playlist(["//other.example/seg.ts"])) });
    assert.deepEqual(urls(await preflight(httpPlaylist)), ["http://other.example/seg.ts"]);
  });

  it("preserves order and legitimate duplicates", async () => {
    fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["b.ts", "a.ts", "b.ts", "a.ts"])) });
    const plan = await preflight();
    assert.equal(plan.fragmentCount, 4);
    assert.deepEqual(urls(plan), [
      "https://origin.example/media/b.ts",
      "https://origin.example/media/a.ts",
      "https://origin.example/media/b.ts",
      "https://origin.example/media/a.ts",
    ]);
  });

  it("accepts a response of exactly HLS_V1_MAX_PLAYLIST_BYTES, with or without Content-Length", async () => {
    const source = playlistOfSize(HLS_V1_MAX_PLAYLIST_BYTES);
    for (const headers of [{}, { "content-length": String(HLS_V1_MAX_PLAYLIST_BYTES) }]) {
      fakeNetwork({ [PLAYLIST_URL]: serve(source, headers) });
      assert.equal((await preflight()).fragmentCount, 1);
    }
  });

  it("accepts a body delivered in many small chunks, including a split multi-byte character", async () => {
    const accented = String.fromCodePoint(0xe9, 0x2713);
    const source = playlist(["seg0.ts", "seg1.ts"], { extra: [`# caf${accented}`] });
    for (const chunkSize of [1, 2, 3, 7]) {
      fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: bodyOf(source, chunkSize).stream } });
      assert.equal((await preflight()).fragmentCount, 2);
    }
  });

  it("accepts an absent or correct Content-Length", async () => {
    const source = playlist(["a.ts"]);
    for (const headers of [{}, { "content-length": String(Buffer.byteLength(source)) }]) {
      fakeNetwork({ [PLAYLIST_URL]: serve(source, headers) });
      assert.equal((await preflight()).fragmentCount, 1);
    }
  });

  it("treats an unparseable Content-Length as absent: the streamed counter decides", async () => {
    for (const value of ["abc", "-1", "1e9", "12 34"]) {
      fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"]), { "content-length": value }) });
      assert.equal((await preflight()).fragmentCount, 1);
    }
  });

  it("does not let Content-Type decide validity in either direction", async () => {
    for (const contentType of [
      "application/vnd.apple.mpegurl",
      "audio/mpegurl",
      "text/plain",
      "application/octet-stream",
      "text/html",
      "video/mp2t",
      undefined,
    ]) {
      const headers: IncomingHttpHeaders = contentType ? { "content-type": contentType } : {};
      fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"]), headers) });
      assert.equal((await preflight()).fragmentCount, 1, `content-type ${String(contentType)}`);
    }
    // A perfect HLS label on a non-HLS document is still refused, by HLS-1.
    fakeNetwork({
      [PLAYLIST_URL]: serve("<html><body>not a playlist</body></html>", {
        "content-type": "application/vnd.apple.mpegurl",
      }),
    });
    const err = await refusedWith(preflight(), "playlist_rejected");
    assert.equal(err.playlistRejection, "missing_extm3u");
  });

  it("accepts exactly HLS_V1_MAX_FRAGMENTS fragments", async () => {
    const references = Array.from({ length: HLS_V1_MAX_FRAGMENTS }, (_, i) => `s${i}.ts`);
    fakeNetwork({ [PLAYLIST_URL]: serve(playlist(references)) });
    const plan = await preflight();
    assert.equal(plan.fragmentCount, HLS_V1_MAX_FRAGMENTS);
    assert.equal(plan.fragments.length, HLS_V1_MAX_FRAGMENTS);
    assert.equal(plan.fragments[HLS_V1_MAX_FRAGMENTS - 1]?.url, `https://origin.example/media/s${HLS_V1_MAX_FRAGMENTS - 1}.ts`);
  });

  it("accepts a resolved fragment URL of exactly HLS_V1_MAX_FRAGMENT_URL_BYTES", async () => {
    const directory = `https://origin.example/${"d".repeat(2500)}/`;
    const reference = `${"a".repeat(HLS_V1_MAX_FRAGMENT_URL_BYTES - directory.length - 3)}.ts`;
    const base = `${directory}index.m3u8`;
    fakeNetwork({ [base]: serve(playlist([reference])) });
    const [url] = urls(await preflight(base));
    assert.equal(Buffer.byteLength(url ?? "", "utf8"), HLS_V1_MAX_FRAGMENT_URL_BYTES);
  });
});

// ── Immutability (§8) ────────────────────────────────────────────────────────

describe("clear-HLS preflight: the plan is immutable", () => {
  it("freezes the plan, the fragment collection and every entry", async () => {
    fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts", "b.ts"])) });
    const plan = await preflight();
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.fragments));
    for (const fragment of plan.fragments) assert.ok(Object.isFrozen(fragment));
  });

  it("cannot be edited by a caller between preflight and acquisition", async () => {
    fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts", "b.ts"])) });
    const plan = await preflight();
    const mutable = plan as unknown as {
      segmentType: string;
      fragmentCount: number;
      fragments: { url: string }[];
    };
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch {
        // Strict mode throws; what matters is the value afterwards.
      }
    };
    attempt(() => {
      mutable.segmentType = "fmp4";
    });
    attempt(() => {
      mutable.fragmentCount = 99;
    });
    attempt(() => {
      mutable.fragments.push({ url: "https://attacker.example/injected.ts" });
    });
    attempt(() => {
      mutable.fragments[0] = { url: "https://attacker.example/swapped.ts" };
    });
    attempt(() => {
      const first = mutable.fragments[0];
      if (first) first.url = "http://127.0.0.1/rewritten.ts";
    });
    assert.equal(plan.segmentType, "mpegts");
    assert.equal(plan.fragmentCount, 2);
    assert.deepEqual(urls(plan), [
      "https://origin.example/media/a.ts",
      "https://origin.example/media/b.ts",
    ]);
  });
});

// ── Negative: the playlist transport (§34) ───────────────────────────────────

describe("clear-HLS preflight: the supplied URL is approved before any I/O", () => {
  const refusedBeforeIo: readonly (readonly [string, readonly string[]])[] = [
    [
      "a non-HTTP scheme",
      [
        "ftp://origin.example/a.m3u8",
        "file:///etc/hosts",
        "javascript:alert(1)",
        "data:application/vnd.apple.mpegurl,%23EXTM3U",
        "ws://origin.example/a.m3u8",
      ],
    ],
    ["a sample: fixture URL", ["sample://fixture/index.m3u8", "sample:hls"]],
    ["a scheme-less or relative location", ["origin.example/index.m3u8", "/index.m3u8", "", "   "]],
    [
      "a private literal address",
      [
        "http://127.0.0.1/a.m3u8",
        "http://10.0.0.1/a.m3u8",
        "http://169.254.169.254/latest",
        "http://2130706433/a.m3u8",
        "http://[::1]/a.m3u8",
        "http://[fd00::1]/a.m3u8",
        "http://[::ffff:127.0.0.1]/a.m3u8",
      ],
    ],
    [
      "a blocked hostname",
      [
        "http://localhost/a.m3u8",
        "http://a.localhost/a.m3u8",
        "http://cdn.local/a.m3u8",
        "http://svc.internal/a.m3u8",
        "http://metadata.google.internal/a.m3u8",
        "http://singlelabel/a.m3u8",
      ],
    ],
    ["embedded credentials", ["https://user:pass@origin.example/a.m3u8", "https://user@origin.example/a.m3u8"]],
  ];
  for (const [label, candidates] of refusedBeforeIo) {
    it(`refuses ${label} without a lookup or a request`, async () => {
      for (const candidate of candidates) {
        const net = fakeNetwork({});
        await refusedWith(preflight(candidate), "invalid_playlist_url");
        assert.deepEqual(net.lookups, [], candidate);
        assert.deepEqual(net.requests, [], candidate);
      }
    });
  }

  it("refuses a non-string location at runtime", async () => {
    const net = fakeNetwork({});
    const request = { playlistUrl: 42, signal: new AbortController().signal };
    await refusedWith(
      preflightClearHlsMediaPlaylist(request as unknown as ClearHlsPreflightRequest),
      "invalid_playlist_url",
    );
    assert.deepEqual(net.requests, []);
  });
});

describe("clear-HLS preflight: request-time destination policy", () => {
  it("refuses a playlist host that resolves privately, without connecting", async () => {
    const url = "https://private-dns.example/a.m3u8";
    const net = fakeNetwork({}, { "private-dns.example": [{ address: "10.0.0.9", family: 4 }] });
    await refusedWith(preflight(url), "destination_rejected");
    assert.deepEqual(net.lookups, ["private-dns.example"]);
    assert.deepEqual(net.requests, []);
  });

  for (const [label, location, dns] of [
    ["a private literal", "http://127.0.0.1/x.m3u8", {}],
    ["a blocked hostname", "http://metadata.google.internal/x", {}],
    ["a sample: URL", "sample://fixture/x.m3u8", {}],
    ["a non-HTTP scheme", "ftp://files.example/x.m3u8", {}],
    ["a malformed location", "http://[::1", {}],
    ["a privately resolving host", "https://rebind.example/x.m3u8", { "rebind.example": [{ address: "169.254.169.254", family: 4 }] }],
    ["an IPv6 private answer", "https://ula.example/x.m3u8", { "ula.example": [{ address: "fd00::1", family: 6 }] }],
  ] as const) {
    it(`refuses a redirect to ${label} and never contacts it`, async () => {
      const net = fakeNetwork({ [PLAYLIST_URL]: redirect(location) }, dns as Record<string, DnsAnswer[]>);
      await refusedWith(preflight(), "destination_rejected");
      assert.deepEqual(net.requests.map((r) => r.url), [PLAYLIST_URL]);
    });
  }
});

describe("clear-HLS preflight: redirect ceiling (§11)", () => {
  const hop = (i: number) => `https://origin.example/hop${i}.m3u8`;

  /** A chain of `redirects` redirects that ends in a valid playlist. */
  function chain(redirects: number): Record<string, Route> {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < redirects; i += 1) routes[hop(i)] = redirect(hop(i + 1));
    routes[hop(redirects)] = serve(playlist(["seg.ts"]));
    return routes;
  }

  it("follows exactly HLS_V1_MAX_PLAYLIST_REDIRECTS redirects", async () => {
    const net = fakeNetwork(chain(HLS_V1_MAX_PLAYLIST_REDIRECTS));
    assert.equal((await preflight(hop(0))).fragmentCount, 1);
    assert.equal(net.requests.length, HLS_V1_MAX_PLAYLIST_REDIRECTS + 1);
  });

  it("refuses one redirect more, without requesting the next hop", async () => {
    const net = fakeNetwork(chain(HLS_V1_MAX_PLAYLIST_REDIRECTS + 1));
    await refusedWith(preflight(hop(0)), "network_error");
    assert.equal(net.requests.length, HLS_V1_MAX_PLAYLIST_REDIRECTS + 1);
    assert.equal(net.requests.some((r) => r.url === hop(HLS_V1_MAX_PLAYLIST_REDIRECTS + 1)), false);
  });

  it("honours a STRICTER application redirect policy", async () => {
    await withConfig({ maxRedirects: 1 }, async () => {
      fakeNetwork(chain(1));
      assert.equal((await preflight(hop(0))).fragmentCount, 1);
      const net = fakeNetwork(chain(2));
      await refusedWith(preflight(hop(0)), "network_error");
      assert.equal(net.requests.length, 2);
    });
  });

  it("never lets a WIDER application policy widen the HLS ceiling", async () => {
    await withConfig({ maxRedirects: 20 }, async () => {
      const net = fakeNetwork(chain(HLS_V1_MAX_PLAYLIST_REDIRECTS + 1));
      await refusedWith(preflight(hop(0)), "network_error");
      assert.equal(net.requests.length, HLS_V1_MAX_PLAYLIST_REDIRECTS + 1);
    });
  });

  it("refuses a redirect without a Location", async () => {
    fakeNetwork({ [PLAYLIST_URL]: { status: 302, headers: {}, body: null } });
    await refusedWith(preflight(), "network_error");
  });
});

describe("clear-HLS preflight: response acceptance (§14–§18)", () => {
  for (const status of [201, 202, 203, 204, 206, 300, 304, 400, 401, 403, 404, 410, 429, 500, 502, 503]) {
    it(`refuses status ${status} and disposes the body`, async () => {
      // A perfectly valid playlist body: the status alone decides.
      const body = bodyOf(playlist(["a.ts"]));
      fakeNetwork({ [PLAYLIST_URL]: { status, body: body.stream } });
      await refusedWith(preflight(), "playlist_http_status");
      assert.equal(body.stats.destroyed, true);
      assert.equal(body.stats.pulled, 0);
    });
  }

  it("refuses a 200 without a body", async () => {
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: null } });
    await refusedWith(preflight(), "network_error");
  });

  for (const encoding of ["gzip", "br", "deflate", "zstd", "GZIP", "gzip, identity", "x-custom", ""]) {
    it(`refuses Content-Encoding ${JSON.stringify(encoding)} without reading the body`, async () => {
      const body = bodyOf(playlist(["a.ts"]));
      fakeNetwork({ [PLAYLIST_URL]: { status: 200, headers: { "content-encoding": encoding }, body: body.stream } });
      await refusedWith(preflight(), "playlist_encoding");
      assert.equal(body.stats.destroyed, true);
      assert.equal(body.stats.pulled, 0);
    });
  }

  it("accepts an explicit identity encoding", async () => {
    for (const encoding of ["identity", "Identity", " identity "]) {
      fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"]), { "content-encoding": encoding }) });
      assert.equal((await preflight()).fragmentCount, 1);
    }
  });

  it("refuses a declared Content-Length over the ceiling before reading anything", async () => {
    for (const declared of [String(HLS_V1_MAX_PLAYLIST_BYTES + 1), "99999999999999999999"]) {
      // The body itself is small and valid: the declaration alone refuses it.
      const body = bodyOf(playlist(["a.ts"]));
      fakeNetwork({ [PLAYLIST_URL]: { status: 200, headers: { "content-length": declared }, body: body.stream } });
      const err = await refusedWith(preflight(), "playlist_too_large");
      assert.equal(err.playlistRejection, null);
      assert.equal(body.stats.pulled, 0);
      assert.equal(body.stats.destroyed, true);
    }
  });

  /** 3 MiB of 64 KiB chunks — half again over the ceiling. */
  function oversizeBody(): TrackedBody {
    const chunk = Buffer.alloc(64 * 1024, 0x23);
    return trackedBody(Array.from({ length: 48 }, () => chunk));
  }

  it("stops reading at the ceiling when the declared length lies (M1)", async () => {
    const body = oversizeBody();
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, headers: { "content-length": "100" }, body: body.stream } });
    await refusedWith(preflight(), "playlist_too_large");
    assert.equal(body.stats.destroyed, true);
    assert.equal(body.stats.ended, false, "the oversize body must not be read to its end");
    assert.ok(body.stats.pulled <= 36, `read ${body.stats.pulled} of 48 chunks`);
  });

  it("stops reading at the ceiling when no length is declared (M1)", async () => {
    const body = oversizeBody();
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: body.stream } });
    await refusedWith(preflight(), "playlist_too_large");
    assert.equal(body.stats.destroyed, true);
    assert.equal(body.stats.ended, false);
    assert.ok(body.stats.pulled <= 36, `read ${body.stats.pulled} of 48 chunks`);
  });

  it("refuses one byte over the ceiling at the transport, before HLS-1", async () => {
    const source = playlistOfSize(HLS_V1_MAX_PLAYLIST_BYTES + 1);
    for (const chunkSize of [64 * 1024, 1024 * 1024, HLS_V1_MAX_PLAYLIST_BYTES + 1]) {
      fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: bodyOf(source, chunkSize).stream } });
      const err = await refusedWith(preflight(), "playlist_too_large");
      assert.equal(err.playlistRejection, null, "HLS-1 never saw it");
    }
  });

  it("refuses a stream that fails mid-body, and disposes it", async () => {
    let destroyed = false;
    let sent = false;
    const stream = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.from("#EXTM3U\n"));
          return;
        }
        this.destroy(new Error("socket hang up"));
      },
      destroy(err, callback) {
        destroyed = true;
        callback(err);
      },
    });
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: stream } });
    await refusedWith(preflight(), "network_error");
    assert.equal(destroyed, true);
  });

  it("refuses a body that yields anything other than bytes", async () => {
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: Readable.from([playlist(["a.ts"])]) } });
    await refusedWith(preflight(), "network_error");
  });
});

describe("clear-HLS preflight: strict UTF-8 (§19)", () => {
  const malformed: readonly (readonly [string, readonly number[]])[] = [
    ["an invalid continuation", [0xc3, 0x28]],
    ["a lone continuation byte", [0x80]],
    ["an overlong encoding", [0xc0, 0xaf]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a truncated sequence", [0xe2, 0x82]],
    ["a code point beyond U+10FFFF", [0xf5, 0x80, 0x80, 0x80]],
  ];
  for (const [label, bytes] of malformed) {
    it(`refuses ${label} rather than substituting U+FFFD (M11)`, async () => {
      // Placed in a COMMENT, which HLS-1 ignores: only the decoder can refuse it.
      const head = Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:10\n# note ", "utf8");
      const tail = Buffer.from("\n#EXTINF:10.0,\na.ts\n#EXT-X-ENDLIST\n", "utf8");
      fakeNetwork({ [PLAYLIST_URL]: serve(Buffer.concat([head, Buffer.from(bytes), tail])) });
      const err = await refusedWith(preflight(), "playlist_invalid_utf8");
      assert.equal(err.playlistRejection, null);
    });
  }

  it("keeps a byte order mark so HLS-1 refuses it (M12)", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    fakeNetwork({ [PLAYLIST_URL]: serve(Buffer.concat([bom, Buffer.from(playlist(["a.ts"]), "utf8")])) });
    const err = await refusedWith(preflight(), "playlist_rejected");
    assert.equal(err.playlistRejection, "byte_order_mark");
  });
});

describe("clear-HLS preflight: HLS-1 is the semantic authority (§20)", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      "an encrypted playlist",
      playlist(["a.ts"], { extra: ['#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"'] }),
      "encrypted",
    ],
    ["a live playlist without ENDLIST", "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\na.ts\n", "missing_endlist"],
    ["an EVENT playlist", playlist(["a.ts"], { extra: ["#EXT-X-PLAYLIST-TYPE:EVENT"] }), "live_or_event"],
    [
      "a master playlist",
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://variants.example/v.m3u8\n",
      "master_playlist",
    ],
    ["an initialization map", playlist(["a.ts"], { extra: ['#EXT-X-MAP:URI="init.mp4"'] }), "initialization_map"],
    ["an empty body", "", "empty"],
  ];
  for (const [label, source, rejection] of cases) {
    it(`refuses ${label} with the HLS-1 reason preserved`, async () => {
      const net = fakeNetwork({ [PLAYLIST_URL]: serve(source) });
      const err = await refusedWith(preflight(), "playlist_rejected");
      assert.equal(err.playlistRejection, rejection);
      // The key, variant or map URI was never requested.
      assert.deepEqual(net.requests.map((r) => r.url), [PLAYLIST_URL]);
    });
  }
});

// ── Negative: fragment resolution (§35) ──────────────────────────────────────

describe("clear-HLS preflight: every fragment URL passes the static policy (§23)", () => {
  const unacceptable: readonly (readonly [string, string])[] = [
    ["file:", "file:///etc/passwd"],
    ["data:", "data:video/mp2t;base64,AAAA"],
    ["ftp:", "ftp://files.example/s.ts"],
    ["javascript:", "javascript:alert(1)"],
    ["sample: (M4)", "sample:fragment"],
    ["sample:// (M4)", "sample://fixture/s.ts"],
    ["localhost", "http://localhost/s.ts"],
    [".localhost", "http://a.localhost/s.ts"],
    [".local", "http://cdn.local/s.ts"],
    [".internal", "http://svc.internal/s.ts"],
    ["a metadata host", "http://metadata.google.internal/s.ts"],
    ["a single-label host", "http://singlelabel/s.ts"],
    ["private IPv4 (M5)", "http://10.1.2.3/s.ts"],
    ["loopback IPv4 (M5)", "http://127.0.0.1/s.ts"],
    ["scheme-relative private IPv4", "//192.168.0.10/s.ts"],
    ["a decimal-encoded loopback", "http://2130706433/s.ts"],
    ["a percent-encoded loopback", "http://%31%32%37.0.0.1/s.ts"],
    ["loopback IPv6 (M5)", "http://[::1]/s.ts"],
    ["unique-local IPv6", "http://[fd00::1]/s.ts"],
    ["link-local IPv6", "http://[fe80::1]/s.ts"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/s.ts"],
    ["a username and password", "http://user:pass@cdn.example/s.ts"],
    ["a username only", "https://user@cdn.example/s.ts"],
    ["a malformed IPv6 host", "http://[::1"],
    ["a missing host", "https://"],
    ["an invalid host code point", "http://exa%mple.com/s.ts"],
  ];

  for (const [label, bad] of unacceptable) {
    it(`refuses the WHOLE plan when one fragment is ${label}`, async () => {
      for (const references of [
        ["first.ts", bad, "third.ts"],
        [bad, "second.ts"],
        ["first.ts", bad],
      ]) {
        fakeNetwork({ [PLAYLIST_URL]: serve(playlist(references)) });
        const err = await refusedWith(preflight(), "fragment_url_invalid");
        assert.equal(err.playlistRejection, null);
      }
    });
  }

  it("refuses a resolved fragment URL one byte over HLS_V1_MAX_FRAGMENT_URL_BYTES", async () => {
    const directory = `https://origin.example/${"d".repeat(2500)}/`;
    const reference = `${"a".repeat(HLS_V1_MAX_FRAGMENT_URL_BYTES - directory.length - 2)}.ts`;
    const base = `${directory}index.m3u8`;
    fakeNetwork({ [base]: serve(playlist(["ok.ts", reference])) });
    await refusedWith(preflight(base), "fragment_url_invalid");
  });

  it("cannot be amplified by a long base URL across many short references", async () => {
    // Each reference is tiny, but inherits a ~4 KiB directory from the base.
    const base = `https://origin.example/${"d".repeat(4096)}/index.m3u8`;
    const references = Array.from({ length: 1000 }, (_, i) => `s${i}.ts`);
    fakeNetwork({ [base]: serve(playlist(references)) });
    await refusedWith(preflight(base), "fragment_url_invalid");
  });
});

// ── One logical request, no fragment I/O (§10, §36, §37) ─────────────────────

describe("clear-HLS preflight: no fragment network I/O and no fragment DNS", () => {
  it("requests only the playlist and its redirect chain, never a fragment (M7)", async () => {
    const final = "https://cdn.example/v1/index.m3u8";
    const net = fakeNetwork({
      [PLAYLIST_URL]: redirect(final),
      [final]: serve(
        playlist([
          "seg0.ts",
          "https://frag-a.example/seg1.ts",
          "//frag-b.example/seg2.ts",
          "/abs/seg3.ts",
          "https://frag-c.example/seg4.ts?sig=abc",
        ]),
      ),
    });
    const plan = await preflight();
    assert.equal(plan.fragmentCount, 5);
    assert.deepEqual(net.requests.map((r) => r.url), [PLAYLIST_URL, final]);
    assert.deepEqual(net.requests.map((r) => r.method), ["GET", "GET"]);
    for (const url of urls(plan)) {
      assert.equal(net.requests.some((r) => r.url === url), false, "a fragment was requested");
    }
  });

  it("looks up only the playlist hosts, never a fragment host (M8)", async () => {
    const final = "https://cdn.example/v1/index.m3u8";
    const net = fakeNetwork({
      [PLAYLIST_URL]: redirect(final),
      [final]: serve(
        playlist([
          "https://frag-a.example/seg0.ts",
          "https://frag-b.example/seg1.ts",
          "https://frag-a.example/seg2.ts",
          "//frag-c.example/seg3.ts",
        ]),
      ),
    });
    await preflight();
    assert.deepEqual(net.lookups, ["origin.example", "cdn.example"]);
  });

  it("does not claim a fragment host resolves publicly: request-time DNS belongs to HLS-3", async () => {
    // This host would resolve to a private address. The preflight never asks,
    // by design; HLS-3's per-request safe-HTTP call is where it would be refused.
    const net = fakeNetwork(
      { [PLAYLIST_URL]: serve(playlist(["https://rebind.example/a.ts"])) },
      { "rebind.example": [{ address: "10.0.0.1", family: 4 }] },
    );
    assert.deepEqual(urls(await preflight()), ["https://rebind.example/a.ts"]);
    assert.deepEqual(net.lookups, ["origin.example"]);
  });

  it("sends only the fixed request profile on every hop, whatever the caller passes (M9)", async () => {
    const final = "https://cdn.example/v1/index.m3u8";
    const net = fakeNetwork({ [PLAYLIST_URL]: redirect(final), [final]: serve(playlist(["a.ts"])) });
    const request = {
      playlistUrl: PLAYLIST_URL,
      signal: new AbortController().signal,
      headers: { Cookie: "session=SECRET", Authorization: "Bearer SECRET", Referer: "https://attacker.invalid/" },
      http_headers: { "User-Agent": "Mozilla/5.0", Cookie: "yt=SECRET" },
      cookies: "a=b",
      referer: "https://attacker.invalid/",
    };
    await preflightClearHlsMediaPlaylist(request as unknown as ClearHlsPreflightRequest);
    assert.equal(net.requests.length, 2);
    for (const recorded of net.requests) assert.deepEqual(recorded.headers, FIXED_PROFILE);
  });
});

// ── Deadline and cancellation (§12, §28, §29) ────────────────────────────────

describe("clear-HLS preflight: one total deadline", () => {
  it("defaults the budget to the analysis limit and never exceeds it", async () => {
    const ceiling = config.analysisTimeoutMs;
    for (const [requested, expected] of [
      [undefined, ceiling],
      [ceiling * 10, ceiling],
      [Number.POSITIVE_INFINITY, ceiling],
      [1234, 1234],
    ] as const) {
      const net = fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"])) });
      await preflight(PLAYLIST_URL, { timeoutMs: requested });
      assert.equal(net.requests[0]?.timeoutMs, expected, `requested ${String(requested)}`);
    }
  });

  it("starts nothing for a budget that is already spent", async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const net = fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"])) });
      await refusedWith(preflight(PLAYLIST_URL, { timeoutMs }), "timeout");
      assert.deepEqual(net.lookups, []);
      assert.deepEqual(net.requests, []);
    }
  });

  it("governs every hop with the SAME signal, not the caller's and not a fresh one", async () => {
    const caller = new AbortController();
    const final = "https://cdn.example/v1/index.m3u8";
    const net = fakeNetwork({
      [PLAYLIST_URL]: redirect("https://hop.example/x.m3u8"),
      "https://hop.example/x.m3u8": redirect(final),
      [final]: serve(playlist(["a.ts"])),
    });
    await preflight(PLAYLIST_URL, { signal: caller.signal });
    const signals = net.requests.map((r) => r.signal);
    assert.equal(signals.length, 3);
    assert.ok(signals[0] instanceof AbortSignal);
    for (const s of signals) assert.equal(s, signals[0]);
    assert.notEqual(signals[0], caller.signal);
    assert.equal(signals[0]?.aborted, true, "the preflight's own controller is released on exit");
    assert.equal(caller.signal.aborted, false, "the caller's signal is never aborted by the preflight");
  });

  it("gives the whole redirect chain ONE budget, not a fresh one per hop", async () => {
    // Four 40 ms hops against a 100 ms budget. A per-hop budget would pass
    // every hop; the total budget expires during the third.
    const hop = (i: number) => `https://origin.example/slow${i}.m3u8`;
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 4; i += 1) {
      routes[hop(i)] = async (args) => {
        await sleep(40, undefined, { signal: args.signal });
        return redirect(hop(i + 1));
      };
    }
    routes[hop(4)] = serve(playlist(["a.ts"]));
    const net = fakeNetwork(routes);
    await refusedWith(preflight(hop(0), { timeoutMs: 100 }), "timeout");
    assert.ok(net.requests.length <= 3, `${net.requests.length} hops attempted`);
  });

  it("expires during a body that stalls after some bytes, and disposes it", async () => {
    const source = Buffer.from(playlist(["a.ts", "b.ts"]), "utf8");
    const body = trackedBody([source.subarray(0, 10), source.subarray(10, 20), source.subarray(20)], {
      stallAfter: 2,
    });
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: body.stream } });
    const started = Date.now();
    await refusedWith(preflight(PLAYLIST_URL, { timeoutMs: 50 }), "timeout");
    assert.ok(Date.now() - started < 5000);
    assert.equal(body.stats.destroyed, true);
    assert.equal(body.stats.pulled, 2);
  });

  it("expires during a DNS lookup that never answers", async () => {
    setSafeHttpTestHooks({
      lookup: () => new Promise<DnsAnswer[]>(() => {}),
      requestOnce: async () => {
        throw new Error("must not connect");
      },
    });
    await refusedWith(preflight(PLAYLIST_URL, { timeoutMs: 30 }), "timeout");
  });

  it("maps a safe-HTTP socket timeout to timeout", async () => {
    setSafeHttpTestHooks({
      lookup: async () => [PUBLIC],
      requestOnce: async () => {
        throw new AppError("TIMEOUT");
      },
    });
    await refusedWith(preflight(), "timeout");
  });
});

describe("clear-HLS preflight: caller cancellation", () => {
  it("starts nothing for a caller that has already cancelled", async () => {
    const caller = new AbortController();
    caller.abort();
    const net = fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"])) });
    await refusedWith(preflight(PLAYLIST_URL, { signal: caller.signal }), "cancelled");
    assert.deepEqual(net.lookups, []);
    assert.deepEqual(net.requests, []);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });

  it("cancels during DNS resolution and starts no request when the lookup later answers", async () => {
    const caller = new AbortController();
    const seen: { release?: (answers: DnsAnswer[]) => void } = {};
    let lookups = 0;
    let requests = 0;
    // Staged, so that a request which never happens can be told apart from one
    // that happened and returned nothing. Hardened safe-HTTP never asks for it.
    const late = bodyOf(playlist(["a.ts"]));
    setSafeHttpTestHooks({
      lookup: () => {
        lookups += 1;
        return new Promise<DnsAnswer[]>((resolveLookup) => {
          seen.release = resolveLookup;
        });
      },
      requestOnce: async () => {
        requests += 1;
        return { status: 200, headers: {}, body: late.stream };
      },
    });
    const pending = preflight(PLAYLIST_URL, { signal: caller.signal });
    await settle();
    assert.equal(lookups, 1);
    assert.equal(typeof seen.release, "function", "the lookup is in flight");
    caller.abort();
    await refusedWith(pending, "cancelled");

    // An OS lookup already in flight cannot be cancelled, so this one answers —
    // with a perfectly usable public address — only after the caller has been
    // answered. That answer is not authoritative: safe-HTTP rechecks the signal
    // after destination resolution and before building a request, so nothing is
    // started from it. No socket, no request, no fragment work, no late body.
    seen.release?.([PUBLIC]);
    await settle();
    assert.equal(lookups, 1, "the late answer starts no further resolution");
    assert.equal(requests, 0, "the late answer starts no request");
    assert.equal(late.stats.pulled, 0);
    assert.equal(late.stats.ended, false);
    assert.equal(late.stats.destroyed, false, "no response body was ever produced to dispose");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });

  it("cancels between redirect hops, and follows no further hop", async () => {
    const caller = new AbortController();
    const hop1 = "https://hop.example/x.m3u8";
    const net = fakeNetwork({
      [PLAYLIST_URL]: redirect(hop1),
      [hop1]: async (args) => {
        caller.abort();
        await sleep(1000, undefined, { signal: args.signal });
        return redirect("https://hop.example/y.m3u8");
      },
    });
    await refusedWith(preflight(PLAYLIST_URL, { signal: caller.signal }), "cancelled");
    await settle();
    assert.deepEqual(net.requests.map((r) => r.url), [PLAYLIST_URL, hop1]);
  });

  it("cancels during the body stream, and disposes the body", async () => {
    const caller = new AbortController();
    const source = Buffer.from(playlist(["a.ts"]), "utf8");
    const body = trackedBody([source.subarray(0, 8), source.subarray(8)], { stallAfter: 1 });
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: body.stream } });
    const pending = preflight(PLAYLIST_URL, { signal: caller.signal });
    await settle();
    assert.equal(body.stats.pulled, 1);
    caller.abort();
    await refusedWith(pending, "cancelled");
    assert.equal(body.stats.destroyed, true);
  });

  it("returns no plan when cancellation lands between body completion and parsing", async () => {
    const caller = new AbortController();
    const bytes = Buffer.from(playlist(["a.ts"]), "utf8");
    // The body is complete and valid. Its disposal runs synchronously in the
    // fetch step's `finally`, BEFORE that step's promise settles; queuing the
    // abort there lands it after the completed body has won the race but
    // before the preflight continues to parse.
    const stream = new Readable({
      read() {},
      destroy(err, callback) {
        queueMicrotask(() => caller.abort());
        callback(err);
      },
    });
    let delivered = false;
    Object.defineProperty(stream, Symbol.asyncIterator, {
      value: () => ({
        next: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: bytes };
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    });
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: stream } });
    await refusedWith(preflight(PLAYLIST_URL, { signal: caller.signal }), "cancelled");
  });

  it("reports the FIRST cause: a caller cancel inside the deadline's abort stays a timeout", async () => {
    const caller = new AbortController();
    const body = trackedBody([Buffer.from("#EXTM3U\n")], { stallAfter: 1 });
    fakeNetwork({
      [PLAYLIST_URL]: (args) => {
        // Fires synchronously while the deadline is aborting the preflight, so
        // both causes land before anything is classified.
        args.signal?.addEventListener("abort", () => caller.abort(), { once: true });
        return { status: 200, body: body.stream };
      },
    });
    await refusedWith(preflight(PLAYLIST_URL, { signal: caller.signal, timeoutMs: 20 }), "timeout");
    assert.equal(caller.signal.aborted, true, "the caller did cancel, second");
  });

  it("reports the FIRST cause: a caller cancel before the deadline stays cancelled", async () => {
    const caller = new AbortController();
    const body = trackedBody([Buffer.from("#EXTM3U\n")], { stallAfter: 1 });
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: body.stream } });
    const pending = preflight(PLAYLIST_URL, { signal: caller.signal, timeoutMs: 200 });
    await settle();
    caller.abort();
    await refusedWith(pending, "cancelled");
  });
});

describe("clear-HLS preflight: nothing outlives the call", () => {
  const outcomes: readonly (readonly [string, () => void, ClearHlsPreflightFailure | null])[] = [
    ["success", () => fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["a.ts"])) }), null],
    ["a refused status", () => fakeNetwork({ [PLAYLIST_URL]: { status: 404, body: bodyOf("x").stream } }), "playlist_http_status"],
    ["an HLS-1 refusal", () => fakeNetwork({ [PLAYLIST_URL]: serve("not a playlist") }), "playlist_rejected"],
    ["a fragment refusal", () => fakeNetwork({ [PLAYLIST_URL]: serve(playlist(["http://127.0.0.1/a.ts"])) }), "fragment_url_invalid"],
    ["a transport failure", () => fakeNetwork({}), "network_error"],
    ["a destination refusal", () => fakeNetwork({}, { "origin.example": [{ address: "10.0.0.1", family: 4 }] }), "destination_rejected"],
  ];
  for (const [label, install, expected] of outcomes) {
    it(`leaves no timer and no caller listener after ${label}`, async () => {
      install();
      const caller = new AbortController();
      const timersBefore = activeTimeouts();
      // A long budget: an uncleared deadline timer would still be pending.
      const pending = preflight(PLAYLIST_URL, { signal: caller.signal, timeoutMs: 30_000 });
      if (expected === null) await pending;
      else await refusedWith(pending, expected);
      assert.ok(activeTimeouts() <= timersBefore, "the deadline timer was cleared");
      assert.equal(getEventListeners(caller.signal, "abort").length, 0, "the caller listener was removed");
    });
  }

  it("leaves no timer and no caller listener after a cancellation", async () => {
    const caller = new AbortController();
    const body = trackedBody([Buffer.from("#EXTM3U\n")], { stallAfter: 1 });
    fakeNetwork({ [PLAYLIST_URL]: { status: 200, body: body.stream } });
    const timersBefore = activeTimeouts();
    const pending = preflight(PLAYLIST_URL, { signal: caller.signal, timeoutMs: 30_000 });
    await settle();
    caller.abort();
    await refusedWith(pending, "cancelled");
    assert.ok(activeTimeouts() <= timersBefore);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    assert.equal(body.stats.destroyed, true);
  });
});

// ── Privacy (§26, §27) ───────────────────────────────────────────────────────

describe("clear-HLS preflight: errors and the plan stay private", () => {
  const SECRETS = [
    "SECRETPATH",
    "SECRETSIG",
    "REDIRSECRET",
    "REDIRTOKEN",
    "FRAGSECRET",
    "FRAGSIG",
    "BODYSECRET",
    "sentinel-origin",
    "sentinel-cdn",
  ];
  const ORIGIN = "https://sentinel-origin.example/SECRETPATH/index.m3u8?sig=SECRETSIG";
  const CDN = "https://sentinel-cdn.example/REDIRSECRET/index.m3u8?token=REDIRTOKEN";

  const failures: readonly (readonly [string, () => Promise<unknown>, ClearHlsPreflightFailure])[] = [
    ["a refused location", () => preflight("ftp://sentinel-origin.example/SECRETPATH?sig=SECRETSIG"), "invalid_playlist_url"],
    [
      "a refused redirect",
      () => {
        fakeNetwork({ [ORIGIN]: redirect("http://127.0.0.1/REDIRSECRET?token=REDIRTOKEN") });
        return preflight(ORIGIN);
      },
      "destination_rejected",
    ],
    [
      "a transport error that names the URL",
      () => {
        setSafeHttpTestHooks({
          lookup: async () => [PUBLIC],
          requestOnce: async (args) => {
            throw new Error(`connect ECONNREFUSED ${args.url.href}`);
          },
        });
        return preflight(ORIGIN);
      },
      "network_error",
    ],
    [
      "a refused status",
      () => {
        fakeNetwork({ [ORIGIN]: redirect(CDN), [CDN]: { status: 403, body: bodyOf("BODYSECRET").stream } });
        return preflight(ORIGIN);
      },
      "playlist_http_status",
    ],
    [
      "an HLS-1 refusal",
      () => {
        fakeNetwork({ [ORIGIN]: serve("<html>BODYSECRET</html>") });
        return preflight(ORIGIN);
      },
      "playlist_rejected",
    ],
    [
      "a refused fragment (M10)",
      () => {
        fakeNetwork({
          [ORIGIN]: redirect(CDN),
          [CDN]: serve(playlist(["ok.ts", "http://10.0.0.1/FRAGSECRET.ts?sig=FRAGSIG"], { title: "BODYSECRET" })),
        });
        return preflight(ORIGIN);
      },
      "fragment_url_invalid",
    ],
    [
      "invalid UTF-8",
      () => {
        fakeNetwork({ [ORIGIN]: serve(Buffer.concat([Buffer.from("#EXTM3U\n# BODYSECRET "), Buffer.from([0xff])])) });
        return preflight(ORIGIN);
      },
      "playlist_invalid_utf8",
    ],
    [
      "a mid-body stream error that names the URL",
      () => {
        const stream = new Readable({
          read() {
            this.destroy(new Error(`aborted ${CDN} BODYSECRET`));
          },
        });
        fakeNetwork({ [ORIGIN]: { status: 200, body: stream } });
        return preflight(ORIGIN);
      },
      "network_error",
    ],
    [
      "a deadline",
      () => {
        fakeNetwork({ [ORIGIN]: { status: 200, body: trackedBody([Buffer.from("#EXTM3U\n")], { stallAfter: 1 }).stream } });
        return preflight(ORIGIN, { timeoutMs: 20 });
      },
      "timeout",
    ],
  ];
  for (const [label, run, reason] of failures) {
    it(`echoes no URL, location, reference or body text after ${label}`, async () => {
      const err = await refusedWith(run(), reason);
      leaksNothing(err, ...SECRETS);
      assert.deepEqual(
        Object.keys(err).sort(),
        ["name", "playlistRejection", "reason"],
        "the error carries only its closed fields",
      );
    });
  }

  it("keeps no playlist text, title, tag or final playlist URL in the plan", async () => {
    fakeNetwork({
      [ORIGIN]: redirect(CDN),
      [CDN]: serve(playlist(["seg.ts"], { title: "BODYSECRET", extra: ["# BODYSECRET comment"] })),
    });
    const plan = await preflight(ORIGIN);
    const rendered = `${JSON.stringify(plan)}\n${inspect(plan, { depth: 10, showHidden: true })}`;
    for (const absent of ["BODYSECRET", "#EXT", "index.m3u8", "REDIRTOKEN", "SECRETSIG", "sentinel-origin"]) {
      assert.equal(rendered.includes(absent), false, `plan must not carry ${absent}`);
    }
    // The fragment itself legitimately lives beside the final playlist.
    assert.deepEqual(urls(plan), ["https://sentinel-cdn.example/REDIRSECRET/seg.ts"]);
  });

  it("carries the HLS-1 reason only for playlist_rejected", () => {
    assert.equal(new ClearHlsPreflightError("network_error", "encrypted").playlistRejection, null);
    assert.equal(new ClearHlsPreflightError("playlist_rejected", "encrypted").playlistRejection, "encrypted");
  });
});

// ── Dormancy and the module boundary (§4, §31, §32, §39, §40) ────────────────

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

describe("clear-HLS preflight: inside its boundary", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  /** The module with its prose removed, so a mention is not mistaken for a call. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export async function preflightClearHlsMediaPlaylist"));
    assert.ok(source.includes("Reachability"), "the prose is really there...");
    assert.equal(code.includes("Reachability"), false, "...and comments should be gone");
  });

  it("never widens yt-dlp's protocol policies: both are still exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("is named by no production module outside the HLS directory", () => {
    for (const file of productionSourceFiles()) {
      if (dirname(file) === HLS_DIR) continue;
      assert.equal(
        readFileSync(file, "utf8").includes("hls-preflight"),
        false,
        `${relative(ROOT, file)} must not import the HLS preflight directly`,
      );
    }
  });

  it("imports only the safe-HTTP client, URL policy, config, errors and HLS-1", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [
      "node:buffer",
      "@/lib/config",
      "@/lib/errors",
      "@/lib/security/safe-http.server",
      "@/lib/validation/url",
      "./hls-media-playlist.ts",
    ]);
  });

  it("makes exactly one logical request, through safeGet, and nothing else", () => {
    assert.equal(code.split("safeGet(").length - 1, 1);
    for (const forbidden of [
      "safeHttpRequest",
      "safeHead",
      "resolveSafeDestination",
      "assertSafeUrl",
      "lookupHost",
      "setSafeHttpTestHooks",
      "fetch(",
      "XMLHttpRequest",
    ]) {
      assert.equal(code.includes(forbidden), false, `the preflight must not reference ${forbidden}`);
    }
  });

  it("names no filesystem, process, DNS, socket or subprocess facility", () => {
    for (const forbidden of [
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "node:tls",
      "node:dgram",
      "node:child_process",
      "node:worker_threads",
      "node:process",
      "require(",
      "import(",
      "spawn",
      "exec",
      "writeFile",
      "createWriteStream",
      "yt-dlp",
      "ffmpeg",
      "ffprobe",
      "process.env",
      "console.",
    ]) {
      assert.equal(code.includes(forbidden), false, `the preflight must not reference ${forbidden}`);
    }
  });

  it("accepts no caller-supplied request headers", () => {
    for (const forbidden of ["headers:", "Cookie", "Authorization", "Referer", "User-Agent", "http_headers"]) {
      assert.equal(code.includes(forbidden), false, `the preflight must not set ${forbidden}`);
    }
  });

  it("lives in the Worker-private HLS directory as a server module", () => {
    const rel = relative(ROOT, MODULE_PATH).split("\\").join("/");
    assert.equal(rel, "src/worker/hls/hls-preflight.server.ts");
  });
});
