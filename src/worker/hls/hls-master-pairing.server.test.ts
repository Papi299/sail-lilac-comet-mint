import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { setSafeHttpTestHooks, type DnsAnswer, type SafeRequestOnce } from "@/lib/security/safe-http.server.ts";
import {
  ClearHlsMasterFetchError,
  SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS,
  acceptClearHlsMasterUrl,
  fetchClearHlsMasterPlaylist,
  proveSeparateHlsAudioPairs,
  proveSeparateHlsPairing,
  type SeparateHlsVideoCandidate,
} from "./hls-master-pairing.server.ts";
import { HLS_MASTER_MAX_PLAYLIST_BYTES, parseClearHlsMasterPlaylist } from "./hls-master-playlist.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: the master-proof seam.
 *
 * The network is scripted at safe-HTTP's lowest hook (`requestOnce`), so the
 * REAL `safeGet` policy — static URL validation, DNS answer validation, the
 * redirect handling under `maxRedirects: 0` — runs for every request here.
 */

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };
const PRIVATE: DnsAnswer = { address: "10.0.0.9", family: 4 };
const TOKEN = "SIGNED_TOKEN_SENTINEL";
const MASTER_URL = `https://cdn.example.com/hls/master.m3u8?sig=${TOKEN}`;
const VIDEO_URL = "https://cdn.example.com/hls/video/1080.m3u8";
const AUDIO_URL = "https://cdn.example.com/hls/audio/main.m3u8";

const GROUP = "GROUP_SENTINEL";
const NAME = "NAME_SENTINEL";
const LANG = "LANG_SENTINEL";

function masterText(...lines: string[]): string {
  return ["#EXTM3U", "#EXT-X-VERSION:7", ...lines, ""].join("\n");
}

const MEDIA = `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${GROUP}",NAME="${NAME}",LANGUAGE="${LANG}",DEFAULT=YES,AUTOSELECT=YES,URI="audio/main.m3u8"`;
const VARIANT = `#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="${GROUP}"`;
const VALID_MASTER = masterText(MEDIA, VARIANT, "video/1080.m3u8");

function candidate(overrides: Partial<SeparateHlsVideoCandidate> = {}): SeparateHlsVideoCandidate {
  return Object.freeze({
    videoPlaylistUrl: VIDEO_URL,
    masterUrl: MASTER_URL,
    width: 1920,
    height: 1080,
    index: 3,
    ...overrides,
  });
}

function prove(text: string, overrides: Partial<SeparateHlsVideoCandidate> = {}, base = MASTER_URL) {
  return proveSeparateHlsPairing(parseClearHlsMasterPlaylist(text), base, candidate(overrides));
}

type Served = { status?: number; headers?: IncomingHttpHeaders; body?: Readable | null };
type Route = Served | ((args: Parameters<SafeRequestOnce>[0]) => Served | Promise<Served>);

function network(routes: Record<string, Route>, dns: Record<string, DnsAnswer[]> = {}) {
  const requests: { url: string; signalAborted: boolean }[] = [];
  const lookups: string[] = [];
  setSafeHttpTestHooks({
    lookup: async (hostname) => {
      lookups.push(hostname);
      return dns[hostname] ?? [PUBLIC];
    },
    requestOnce: async (args) => {
      requests.push({ url: args.url.href, signalAborted: args.signal?.aborted ?? false });
      const route = routes[args.url.href];
      if (route === undefined) throw new Error("unrouted synthetic request");
      const served = typeof route === "function" ? await route(args) : route;
      return { status: served.status ?? 200, headers: served.headers ?? {}, body: served.body ?? null };
    },
  });
  return { requests, lookups };
}

const body = (bytes: Buffer | string, headers: IncomingHttpHeaders = {}): Served => ({
  status: 200,
  headers,
  body: Readable.from([Buffer.from(bytes)]),
});

afterEach(() => setSafeHttpTestHooks(null));

async function fetchFailure(masterUrl = MASTER_URL, timeoutMs = 5_000, signal = new AbortController().signal) {
  try {
    await fetchClearHlsMasterPlaylist({ masterUrl, signal, timeoutMs });
  } catch (err) {
    assert.ok(err instanceof ClearHlsMasterFetchError, `expected a fetch refusal, got ${String(err)}`);
    return err;
  }
  assert.fail("the master was accepted");
}

describe("master location acceptance (pure)", () => {
  it("accepts an absolute canonical join-stable public http(s) URL exactly as given", () => {
    for (const url of [MASTER_URL, "http://cdn.example.com/master.m3u8", "https://cdn.example.com:8443/a/master.m3u8?x=1&y=2"]) {
      assert.equal(acceptClearHlsMasterUrl(url), url);
    }
  });

  it("refuses everything else without any I/O", () => {
    for (const raw of [
      undefined,
      null,
      42,
      {},
      "",
      "master.m3u8",
      "/hls/master.m3u8",
      "//cdn.example.com/master.m3u8",
      "HTTPS://cdn.example.com/master.m3u8",
      "https://CDN.example.com/master.m3u8",
      "https://cdn.example.com:443/master.m3u8",
      "https://cdn.example.com",
      "https://cdn.example.com/",
      "https://cdn.example.com/hls/",
      "https://cdn.example.com/a//master.m3u8",
      "https://cdn.example.com/a/../master.m3u8",
      "https://cdn.example.com/master.m3u8?",
      "https://cdn.example.com/master.m3u8;p=1",
      "https://cdn.example.com/master.m3u8#frag",
      "https://user:pass@cdn.example.com/master.m3u8",
      "ftp://cdn.example.com/master.m3u8",
      "sample:master",
      "https://127.0.0.1/master.m3u8",
      "https://10.1.2.3/master.m3u8",
      "https://localhost/master.m3u8",
      "https://printer.local/master.m3u8",
      ` ${MASTER_URL}`,
      `https://cdn.example.com/${"a".repeat(4096)}.m3u8`,
    ]) {
      assert.equal(acceptClearHlsMasterUrl(raw), null, String(raw).slice(0, 80));
    }
  });
});

describe("the association proof (pure)", () => {
  it("proves the ONE audio playlist of the exact selected variant", () => {
    assert.deepEqual(prove(VALID_MASTER), { ok: true, audioPlaylistUrl: AUDIO_URL });
  });

  it("returns nothing but the audio URL: no group id, NAME, LANGUAGE or master location", () => {
    const serialized = JSON.stringify(prove(VALID_MASTER));
    for (const needle of [GROUP, NAME, LANG, "master.m3u8", TOKEN]) {
      assert.equal(serialized.includes(needle), false, needle);
    }
  });

  it("keeps signed queries significant on both sides", () => {
    const signed = masterText(
      MEDIA.replace('URI="audio/main.m3u8"', 'URI="audio/main.m3u8?atok=A1"'),
      VARIANT,
      "video/1080.m3u8?vtok=V1",
    );
    assert.deepEqual(prove(signed, { videoPlaylistUrl: `${VIDEO_URL}?vtok=V1` }), {
      ok: true,
      audioPlaylistUrl: `${AUDIO_URL}?atok=A1`,
    });
    // The same path with another (or no) signature is NOT the selected variant.
    assert.deepEqual(prove(signed, { videoPlaylistUrl: `${VIDEO_URL}?vtok=V2` }), {
      ok: false,
      refusal: "selected_variant_not_in_master",
    });
    assert.deepEqual(prove(signed), { ok: false, refusal: "selected_variant_not_in_master" });
  });

  it("resolves root-relative and absolute references against the exact master location", () => {
    const rooted = masterText(
      MEDIA.replace('URI="audio/main.m3u8"', 'URI="/hls/audio/main.m3u8"'),
      VARIANT,
      "https://cdn.example.com/hls/video/1080.m3u8",
    );
    assert.deepEqual(prove(rooted), { ok: true, audioPlaylistUrl: AUDIO_URL });
  });

  it("refuses when the selected URL is absent, and never picks a 'closest' variant", () => {
    assert.deepEqual(prove(masterText(MEDIA, VARIANT, "video/720.m3u8")), {
      ok: false,
      refusal: "selected_variant_not_in_master",
    });
    // Same filename, different directory: not the selected playlist.
    assert.deepEqual(prove(masterText(MEDIA, VARIANT, "other/1080.m3u8")), {
      ok: false,
      refusal: "selected_variant_not_in_master",
    });
  });

  it("refuses two associations for the selected URL, conflicting or not", () => {
    const second = `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",NAME="o",URI="audio/other.m3u8"`;
    const conflicting = masterText(MEDIA, second, VARIANT, "video/1080.m3u8", VARIANT.replace(`AUDIO="${GROUP}"`, 'AUDIO="other"'), "video/1080.m3u8");
    assert.deepEqual(prove(conflicting), { ok: false, refusal: "duplicate_variant_url" });
    const repeated = masterText(MEDIA, VARIANT, "video/1080.m3u8", VARIANT, "video/1080.m3u8");
    assert.deepEqual(prove(repeated), { ok: false, refusal: "duplicate_variant_url" });
    // Two spellings of one URL are one URL.
    const spelled = masterText(MEDIA, VARIANT, "video/1080.m3u8", VARIANT, "/hls/video/1080.m3u8");
    assert.deepEqual(prove(spelled), { ok: false, refusal: "duplicate_variant_url" });
  });

  it("refuses a selected variant with no AUDIO group", () => {
    const ungrouped = masterText(MEDIA, '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,CODECS="avc1.640028"', "video/1080.m3u8");
    assert.deepEqual(prove(ungrouped), { ok: false, refusal: "variant_has_no_audio_group" });
  });

  it("refuses a group with several URI renditions (Option A: no preference policy)", () => {
    const multi = masterText(
      MEDIA,
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${GROUP}",NAME="alt",LANGUAGE="he",URI="audio/alt.m3u8"`,
      VARIANT,
      "video/1080.m3u8",
    );
    assert.deepEqual(prove(multi), { ok: false, refusal: "ambiguous_audio_group" });
  });

  it("refuses an in-band member, alone or beside a URI rendition", () => {
    const inBand = masterText(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${GROUP}",NAME="in"`, VARIANT, "video/1080.m3u8");
    assert.deepEqual(prove(inBand), { ok: false, refusal: "audio_group_has_in_band_member" });
    const mixed = masterText(MEDIA, `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${GROUP}",NAME="in"`, VARIANT, "video/1080.m3u8");
    assert.deepEqual(prove(mixed), { ok: false, refusal: "audio_group_has_in_band_member" });
  });

  it("checks RESOLUTION against the row's dimensions, in both directions", () => {
    assert.deepEqual(prove(VALID_MASTER, { height: 720, width: 1280 }), {
      ok: false,
      refusal: "variant_resolution_inconsistent",
    });
    assert.deepEqual(prove(VALID_MASTER, { height: null, width: null }), {
      ok: false,
      refusal: "variant_resolution_inconsistent",
    });
    const unsized = masterText(MEDIA, VARIANT.replace("RESOLUTION=1920x1080,", ""), "video/1080.m3u8");
    assert.deepEqual(prove(unsized), { ok: false, refusal: "variant_resolution_inconsistent" });
    assert.deepEqual(prove(unsized, { height: null, width: null }), { ok: true, audioPlaylistUrl: AUDIO_URL });
  });

  it("refuses an audio URL that is not an acceptable public playlist, or that is a variant", () => {
    const privateAudio = masterText(MEDIA.replace('URI="audio/main.m3u8"', 'URI="https://10.0.0.1/a.m3u8"'), VARIANT, "video/1080.m3u8");
    assert.deepEqual(prove(privateAudio), { ok: false, refusal: "audio_url_invalid" });
    const sameAsVideo = masterText(MEDIA.replace('URI="audio/main.m3u8"', 'URI="video/1080.m3u8"'), VARIANT, "video/1080.m3u8");
    assert.deepEqual(prove(sameAsVideo), { ok: false, refusal: "audio_url_is_variant_url" });
    const otherVariant = masterText(
      MEDIA.replace('URI="audio/main.m3u8"', 'URI="video/720.m3u8"'),
      VARIANT,
      "video/1080.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f"',
      "video/720.m3u8",
    );
    assert.deepEqual(prove(otherVariant), { ok: false, refusal: "audio_url_is_variant_url" });
  });
});

describe("the master fetch: one zero-redirect safe-HTTP GET", () => {
  it("fetches, bounds, decodes and parses one master", async () => {
    const { requests } = network({ [MASTER_URL]: () => body(VALID_MASTER) });
    const model = await fetchClearHlsMasterPlaylist({ masterUrl: MASTER_URL, signal: new AbortController().signal, timeoutMs: 5_000 });
    assert.equal(model.variants.length, 1);
    assert.deepEqual(requests.map((r) => r.url), [MASTER_URL]);
  });

  it("REFUSES a 30x and never resolves or requests the redirect target", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const target = "https://elsewhere.example.net/master.m3u8";
      const { requests, lookups } = network({
        [MASTER_URL]: { status, headers: { location: target }, body: Readable.from([Buffer.from("moved")]) },
        [target]: () => body(VALID_MASTER),
      });
      const err = await fetchFailure();
      assert.equal(err.reason, "network_error", String(status));
      assert.deepEqual(requests.map((r) => r.url), [MASTER_URL], "the redirect target is never requested");
      assert.deepEqual(lookups, ["cdn.example.com"], "the redirect target is never even resolved");
    }
  });

  it("refuses any status other than exactly 200", async () => {
    for (const status of [204, 206, 300, 304, 403, 404, 500]) {
      network({ [MASTER_URL]: { status, body: Readable.from([Buffer.from(VALID_MASTER)]) } });
      assert.equal((await fetchFailure()).reason, "master_http_status", String(status));
    }
  });

  it("refuses a non-identity Content-Encoding", async () => {
    network({ [MASTER_URL]: () => body(VALID_MASTER, { "content-encoding": "gzip" }) });
    assert.equal((await fetchFailure()).reason, "master_encoding");
  });

  it("refuses a declared or streamed body over the master ceiling", async () => {
    network({ [MASTER_URL]: () => body(VALID_MASTER, { "content-length": String(HLS_MASTER_MAX_PLAYLIST_BYTES + 1) }) });
    assert.equal((await fetchFailure()).reason, "master_too_large");
    let pulled = 0;
    const chunks = function* () {
      for (let i = 0; i < 100; i += 1) {
        pulled += 1;
        yield Buffer.alloc(16 * 1024, 0x23);
      }
    };
    network({ [MASTER_URL]: () => ({ status: 200, body: Readable.from(chunks()) }) });
    assert.equal((await fetchFailure()).reason, "master_too_large");
    assert.ok(pulled <= 18, `the body is not consumed past the ceiling (${pulled} chunks)`);
  });

  it("refuses invalid UTF-8 rather than repairing it", async () => {
    network({ [MASTER_URL]: () => body(Buffer.concat([Buffer.from("#EXTM3U\n"), Buffer.from([0xff, 0xfe, 0x0a])])) });
    assert.equal((await fetchFailure()).reason, "master_invalid_utf8");
  });

  it("carries the closed grammar's reason for a rejected document", async () => {
    network({ [MASTER_URL]: () => body(masterText("#EXTINF:1.0,", VARIANT, "v.m3u8")) });
    const err = await fetchFailure();
    assert.equal(err.reason, "master_rejected");
    assert.equal(err.masterRejection, "media_playlist");
  });

  it("refuses a private DNS answer at request time", async () => {
    const { requests } = network({ [MASTER_URL]: () => body(VALID_MASTER) }, { "cdn.example.com": [PRIVATE] });
    assert.equal((await fetchFailure()).reason, "destination_rejected");
    assert.equal(requests.length, 0);
  });

  it("refuses an unacceptable location before any I/O", async () => {
    const { requests, lookups } = network({});
    assert.equal((await fetchFailure("https://cdn.example.com/a/../m.m3u8")).reason, "invalid_master_url");
    assert.equal(requests.length + lookups.length, 0);
  });

  it("stops on its deadline and on cancellation", async () => {
    network({
      [MASTER_URL]: (args) =>
        new Promise<Served>((_, reject) => {
          args.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    assert.equal((await fetchFailure(MASTER_URL, 40)).reason, "timeout");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    assert.equal((await fetchFailure(MASTER_URL, 5_000, controller.signal)).reason, "cancelled");
    const gone = new AbortController();
    gone.abort();
    const { requests } = network({ [MASTER_URL]: () => body(VALID_MASTER) });
    assert.equal((await fetchFailure(MASTER_URL, 5_000, gone.signal)).reason, "cancelled");
    assert.equal(requests.length, 0);
  });

  it("puts no location, token, host or document text in any refusal", async () => {
    const reasons = [
      () => network({ [MASTER_URL]: { status: 302, headers: { location: `https://x.example.net/${TOKEN}` } } }),
      () => network({ [MASTER_URL]: { status: 404 } }),
      () => network({ [MASTER_URL]: () => body(masterText(`#EXT-X-${TOKEN}:1`)) }),
    ];
    for (const arm of reasons) {
      arm();
      const err = await fetchFailure();
      const text = `${err.message} ${String(err.stack)}`;
      for (const needle of [TOKEN, "cdn.example.com", "x.example.net", "master.m3u8"]) {
        assert.equal(text.includes(needle), false, needle);
      }
    }
  });
});

describe("proving pairs within the analysis bounds", () => {
  it("fetches each master ONCE for all of its candidates, and returns only proven pairs", async () => {
    const twoVariants = masterText(
      MEDIA,
      VARIANT,
      "video/1080.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS="avc1.64001f"',
      "video/720.m3u8",
    );
    const { requests } = network({ [MASTER_URL]: () => body(twoVariants) });
    const pairs = await proveSeparateHlsAudioPairs({
      candidates: [
        candidate(),
        candidate({ videoPlaylistUrl: "https://cdn.example.com/hls/video/720.m3u8", width: 1280, height: 720, index: 4 }),
      ],
      timeoutMs: 5_000,
    });
    assert.deepEqual(requests.map((r) => r.url), [MASTER_URL]);
    assert.deepEqual(JSON.parse(JSON.stringify(pairs)), [
      { videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080, index: 3 },
    ]);
    assert.ok(Object.isFrozen(pairs) && Object.isFrozen(pairs[0]));
    assert.equal(JSON.stringify(pairs).includes("master.m3u8"), false, "no master location survives");
  });

  it(`fetches NOTHING and proves nothing past ${SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS} distinct masters`, async () => {
    const masters = Array.from(
      { length: SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS + 1 },
      (_, i) => `https://cdn.example.com/m${i}/master.m3u8`,
    );
    const { requests } = network(Object.fromEntries(masters.map((m) => [m, () => body(VALID_MASTER)])));
    const pairs = await proveSeparateHlsAudioPairs({
      candidates: masters.map((masterUrl, i) => candidate({ masterUrl, index: i })),
      timeoutMs: 5_000,
    });
    assert.deepEqual(pairs, []);
    assert.equal(requests.length, 0);
  });

  it("fetches up to the cap, and one failing master does not affect another", async () => {
    const good = "https://cdn.example.com/good/master.m3u8";
    const bad = "https://cdn.example.com/bad/master.m3u8";
    const goodVideo = "https://cdn.example.com/good/video/1080.m3u8";
    const { requests } = network({ [bad]: { status: 500 }, [good]: () => body(VALID_MASTER) });
    const pairs = await proveSeparateHlsAudioPairs({
      candidates: [candidate({ masterUrl: bad, index: 1 }), candidate({ masterUrl: good, videoPlaylistUrl: goodVideo, index: 2 })],
      timeoutMs: 5_000,
    });
    assert.deepEqual(requests.map((r) => r.url), [bad, good]);
    assert.deepEqual(pairs.map((p) => [p.index, p.audioPlaylistUrl]), [[2, "https://cdn.example.com/good/audio/main.m3u8"]]);
  });

  it("returns nothing once cancelled, and starts no further fetch", async () => {
    const controller = new AbortController();
    const first = "https://cdn.example.com/a/master.m3u8";
    const second = "https://cdn.example.com/b/master.m3u8";
    const { requests } = network({
      [first]: () => {
        controller.abort();
        return body(VALID_MASTER);
      },
      [second]: () => body(VALID_MASTER),
    });
    const pairs = await proveSeparateHlsAudioPairs({
      candidates: [candidate({ masterUrl: first, index: 1 }), candidate({ masterUrl: second, index: 2 })],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    assert.deepEqual(pairs, []);
    assert.deepEqual(requests.map((r) => r.url), [first]);
  });

  it("starts nothing without a budget", async () => {
    const { requests } = network({ [MASTER_URL]: () => body(VALID_MASTER) });
    assert.deepEqual(await proveSeparateHlsAudioPairs({ candidates: [candidate()], timeoutMs: 0 }), []);
    assert.equal(requests.length, 0);
  });
});
