import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLEAR_HLS_SHADOW_BEST_PRESET_ID,
  CLEAR_HLS_SHADOW_PRESET_ID_PATTERN,
  CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES,
  CLEAR_HLS_V1_SHADOW_PROTOCOL,
  acceptClearHlsPlaylistUrl,
  buildClearHlsMediaPlaylistSelections,
  isClearHlsShadowProtocol,
  type ClearHlsShadowCandidate,
  type ClearHlsShadowRung,
} from "./hls-source-selection.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, "hls-source-selection.ts");
const ROOT = join(HERE, "..", "..", "..");

/**
 * The conspicuous private sentinel. Every URL in this file carries it so that
 * "the token did not leak" is checkable rather than merely intended: a refusal
 * that named the rejected URL, or a selection that reached a public surface,
 * would put this exact string somewhere it is asserted not to be.
 */
const TOKEN = "VERY_PRIVATE_HLS_TOKEN";
const SIGNED_URL = `https://media.example.invalid/hls/media.m3u8?sig=${TOKEN}`;

/**
 * The analyzer's real ladder shape. The analyzer passes its OWN
 * `RESOLUTION_STEPS`; this mirror exists so the placement rules can be tested
 * in isolation, and `hls-shadow-selection.server.test.ts` proves the real one
 * is what production injects.
 */
const RUNGS: readonly ClearHlsShadowRung[] = Object.freeze([
  { minHeight: 2160, id: "preset:2160" },
  { minHeight: 1440, id: "preset:1440" },
  { minHeight: 1080, id: "preset:1080" },
  { minHeight: 720, id: "preset:720" },
  { minHeight: 480, id: "preset:480" },
  { minHeight: 360, id: "preset:360" },
  { minHeight: 240, id: "preset:240" },
  { minHeight: 144, id: "preset:144" },
]);

function candidate(
  over: Partial<ClearHlsShadowCandidate> = {},
): ClearHlsShadowCandidate {
  return { playlistUrl: SIGNED_URL, height: 1080, index: 0, ...over };
}

/** A URL whose UTF-8 length is exactly `bytes`, already in normalised form. */
function urlOfExactly(bytes: number): string {
  const base = `https://media.example.invalid/hls/media.m3u8?sig=${TOKEN}&pad=`;
  const padding = bytes - Buffer.byteLength(base, "utf8");
  assert.ok(padding >= 0, "the base must fit inside the requested size");
  const url = `${base}${"a".repeat(padding)}`;
  assert.equal(Buffer.byteLength(url, "utf8"), bytes);
  // Already canonical, so the serialisation-consistency check cannot be the
  // thing under test here — the length is.
  assert.equal(new URL(url).href, url);
  return url;
}

// ── Static URL acceptance (§12, §20) ─────────────────────────────────────────

describe("clear-HLS playlist URL: what is accepted", () => {
  it("accepts an absolute HTTPS location and returns it unchanged", () => {
    assert.equal(acceptClearHlsPlaylistUrl(SIGNED_URL), SIGNED_URL);
  });

  it("accepts an absolute HTTP location", () => {
    const url = `http://media.example.invalid/hls/media.m3u8?sig=${TOKEN}`;
    assert.equal(acceptClearHlsPlaylistUrl(url), url);
  });

  it("carries a signed query string EXACTLY, with nothing stripped or reordered", () => {
    // A stripped signature is a URL that 403s at acquisition time, which is a
    // worse outcome than never selecting the rendition.
    const url =
      `https://cdn.example.invalid/v/1/media.m3u8` +
      `?Expires=1789000000&Signature=${TOKEN}&Key-Pair-Id=ABCDEF&a=1&A=2`;
    const accepted = acceptClearHlsPlaylistUrl(url);
    assert.equal(accepted, url);
    assert.ok(accepted?.includes(TOKEN));
    assert.ok(accepted?.includes("a=1&A=2"), "query order and case are preserved");
  });

  it("accepts an ordinary CDN hostname with a deep path", () => {
    const url = "https://vod-akc-eu-central-1.example-cdn.invalid/a/b/c/d/index-f2-v1-a1.m3u8";
    assert.equal(acceptClearHlsPlaylistUrl(url), url);
  });

  it("accepts a URL of exactly the byte ceiling", () => {
    const url = urlOfExactly(CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES);
    assert.equal(acceptClearHlsPlaylistUrl(url), url);
  });

  it("retains the WHATWG serialisation, so surrounding whitespace is stripped", () => {
    // The same reading HLS-2 gives a playlist location. What matters is that
    // the value RETAINED is the one that was checked, which it is: the
    // canonical form, not the padded field.
    assert.equal(acceptClearHlsPlaylistUrl(`  ${SIGNED_URL}\n`), SIGNED_URL);
  });
});

describe("clear-HLS playlist URL: what is refused", () => {
  /** Each case is `[label, value]`; none may be accepted, and none may throw. */
  const REFUSED: readonly (readonly [string, unknown])[] = [
    ["missing (undefined)", undefined],
    ["missing (null)", null],
    ["not a string (number)", 12345],
    ["not a string (object)", { href: SIGNED_URL }],
    ["not a string (array)", [SIGNED_URL]],
    ["empty", ""],
    ["whitespace only", "   "],
    ["relative", `/hls/media.m3u8?sig=${TOKEN}`],
    ["relative, no leading slash", `media.m3u8?sig=${TOKEN}`],
    ["protocol-relative", `//media.example.invalid/hls/media.m3u8?sig=${TOKEN}`],
    ["scheme-less host", `media.example.invalid/hls/media.m3u8?sig=${TOKEN}`],
    ["file:", `file:///srv/media/media.m3u8?sig=${TOKEN}`],
    ["data:", `data:application/vnd.apple.mpegurl,#EXTM3U ${TOKEN}`],
    ["ftp:", `ftp://media.example.invalid/hls/media.m3u8?sig=${TOKEN}`],
    ["javascript:", `javascript:alert("${TOKEN}")`],
    ["the sample pseudo-protocol", `sample://media.m3u8?sig=${TOKEN}`],
    ["credential-bearing", `https://user:pass@media.example.invalid/m.m3u8?sig=${TOKEN}`],
    ["username only", `https://user@media.example.invalid/m.m3u8?sig=${TOKEN}`],
    ["localhost", `https://localhost/hls/media.m3u8?sig=${TOKEN}`],
    ["a .localhost name", `https://cdn.localhost/hls/media.m3u8?sig=${TOKEN}`],
    ["a .internal name", `https://cache.internal/hls/media.m3u8?sig=${TOKEN}`],
    ["link-local metadata", `https://metadata.google.internal/m.m3u8?sig=${TOKEN}`],
    ["a single-label host", `https://cdn/hls/media.m3u8?sig=${TOKEN}`],
    ["a loopback literal", `https://127.0.0.1/hls/media.m3u8?sig=${TOKEN}`],
    ["a private IPv4 literal", `https://10.1.2.3/hls/media.m3u8?sig=${TOKEN}`],
    ["a link-local IPv4 literal", `https://169.254.169.254/latest/m.m3u8?sig=${TOKEN}`],
    ["an IPv6 loopback literal", `https://[::1]/hls/media.m3u8?sig=${TOKEN}`],
    ["a unique-local IPv6 literal", `https://[fd00::1]/hls/media.m3u8?sig=${TOKEN}`],
    ["malformed", `https://exa mple.invalid/hls/media.m3u8?sig=${TOKEN}`],
    ["malformed (bare scheme)", "https://"],
  ];

  for (const [label, value] of REFUSED) {
    it(`refuses ${label}`, () => {
      assert.equal(acceptClearHlsPlaylistUrl(value), null);
    });
  }

  it("refuses a URL one byte over the ceiling", () => {
    const url = urlOfExactly(CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES + 1);
    assert.equal(acceptClearHlsPlaylistUrl(url), null);
  });

  it("refuses a URL bounded in code units but over the ceiling in UTF-8 bytes", () => {
    // Multi-byte characters in a query are percent-encoded by serialisation, so
    // the RETAINED value is longer than the input. The ceiling is enforced on
    // what is kept, not only on what arrived.
    const raw = `https://media.example.invalid/m.m3u8?sig=${TOKEN}&x=${"é".repeat(1500)}`;
    assert.ok(raw.length < CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES, "under the ceiling in code units");
    assert.ok(
      Buffer.byteLength(new URL(raw).href, "utf8") > CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES,
      "but over it once serialised",
    );
    assert.equal(acceptClearHlsPlaylistUrl(raw), null);
  });

  it("refuses a multi-megabyte field without parsing it", () => {
    const huge = `https://media.example.invalid/m.m3u8?sig=${"a".repeat(4 * 1024 * 1024)}`;
    assert.equal(acceptClearHlsPlaylistUrl(huge), null);
  });

  it("never throws, and never names the refused URL", () => {
    // Every refusal is a returned null. Nothing here may construct an error
    // message, because an error message is a place a signed URL could end up.
    for (const [, value] of REFUSED) {
      assert.doesNotThrow(() => acceptClearHlsPlaylistUrl(value));
    }
  });

  it("retains only a serialisation that re-parses to the same policy", () => {
    // The approval is made on the exact string that is returned, so whatever
    // comes back must still satisfy the invariants when read again.
    const accepted = acceptClearHlsPlaylistUrl(SIGNED_URL);
    assert.ok(accepted);
    const reparsed = new URL(accepted);
    assert.equal(reparsed.href, accepted);
    assert.equal(reparsed.protocol, "https:");
    assert.equal(reparsed.username, "");
    assert.equal(reparsed.password, "");
  });
});

// ── Protocol admission (§13, §21) ────────────────────────────────────────────

describe("clear-HLS shadow protocol: m3u8_native exactly", () => {
  it("admits the native spelling, tolerating case and surrounding space", () => {
    for (const value of ["m3u8_native", "M3U8_NATIVE", " m3u8_native ", "\tm3u8_Native\n"]) {
      assert.equal(isClearHlsShadowProtocol(value), true, value);
    }
    assert.equal(CLEAR_HLS_V1_SHADOW_PROTOCOL, "m3u8_native");
  });

  it("refuses every other protocol, `m3u8` included", () => {
    for (const value of [
      "m3u8",
      "http",
      "https",
      "http_dash_segments",
      "http_dash_segments_generator",
      "rtmp",
      "mms",
      "ws",
      "m3u8_nativex",
      "xm3u8_native",
      "",
      "   ",
      undefined,
      null,
      8,
      {},
    ]) {
      assert.equal(isClearHlsShadowProtocol(value), false, String(value));
    }
  });
});

// ── The shadow ladder (§14, §22) ─────────────────────────────────────────────

describe("clear-HLS shadow ladder: deterministic placement", () => {
  it("returns a frozen empty map when there is no candidate", () => {
    const map = buildClearHlsMediaPlaylistSelections([], RUNGS);
    assert.deepEqual(map, {});
    assert.equal(Object.isFrozen(map), true);
  });

  it("backs preset:best from the highest occupied bucket", () => {
    const map = buildClearHlsMediaPlaylistSelections(
      [
        candidate({ height: 360, index: 0, playlistUrl: `${SIGNED_URL}&r=360` }),
        candidate({ height: 1080, index: 1, playlistUrl: `${SIGNED_URL}&r=1080` }),
        candidate({ height: 720, index: 2, playlistUrl: `${SIGNED_URL}&r=720` }),
      ],
      RUNGS,
    );
    assert.equal(map["preset:best"]?.playlistUrl, `${SIGNED_URL}&r=1080`);
    assert.equal(map["preset:best"]?.height, 1080);
  });

  it("places each candidate on its exact rung, and no other", () => {
    const map = buildClearHlsMediaPlaylistSelections(
      [
        candidate({ height: 2160, index: 0, playlistUrl: `${SIGNED_URL}&r=2160` }),
        candidate({ height: 1080, index: 1, playlistUrl: `${SIGNED_URL}&r=1080` }),
        candidate({ height: 480, index: 2, playlistUrl: `${SIGNED_URL}&r=480` }),
        candidate({ height: 144, index: 3, playlistUrl: `${SIGNED_URL}&r=144` }),
      ],
      RUNGS,
    );
    assert.deepEqual(Object.keys(map).sort(), [
      "preset:1080",
      "preset:144",
      "preset:2160",
      "preset:480",
      "preset:best",
    ]);
    assert.equal(map["preset:2160"]?.playlistUrl, `${SIGNED_URL}&r=2160`);
    assert.equal(map["preset:1080"]?.playlistUrl, `${SIGNED_URL}&r=1080`);
    assert.equal(map["preset:480"]?.playlistUrl, `${SIGNED_URL}&r=480`);
    assert.equal(map["preset:144"]?.playlistUrl, `${SIGNED_URL}&r=144`);
    assert.equal(map["preset:best"]?.playlistUrl, `${SIGNED_URL}&r=2160`);
  });

  it("does not let a 1080 candidate also masquerade as 720 or below", () => {
    const map = buildClearHlsMediaPlaylistSelections([candidate({ height: 1080 })], RUNGS);
    assert.deepEqual(Object.keys(map).sort(), ["preset:1080", "preset:best"]);
    for (const id of ["preset:720", "preset:480", "preset:360", "preset:240", "preset:144"]) {
      assert.equal(map[id], undefined, `${id} must stay empty`);
    }
  });

  it("puts a height inside a rung's range on that rung, not the one it exceeds", () => {
    // 1200 is at or above the 1080 floor and below the 1440 floor.
    const map = buildClearHlsMediaPlaylistSelections([candidate({ height: 1200 })], RUNGS);
    assert.equal(map["preset:1080"]?.height, 1200);
    assert.equal(map["preset:1440"], undefined);
  });

  it("resolves a tie inside one rung by upstream position", () => {
    const first = candidate({ height: 1080, index: 3, playlistUrl: `${SIGNED_URL}&pick=me` });
    const later = candidate({ height: 1100, index: 9, playlistUrl: `${SIGNED_URL}&pick=no` });
    for (const order of [[first, later], [later, first]]) {
      const map = buildClearHlsMediaPlaylistSelections(order, RUNGS);
      assert.equal(map["preset:1080"]?.playlistUrl, `${SIGNED_URL}&pick=me`);
      assert.equal(map["preset:best"]?.playlistUrl, `${SIGNED_URL}&pick=me`);
    }
  });

  it("lets an unknown-height candidate back preset:best, and only that", () => {
    const map = buildClearHlsMediaPlaylistSelections(
      [
        candidate({ height: null, index: 2, playlistUrl: `${SIGNED_URL}&u=late` }),
        candidate({ height: null, index: 1, playlistUrl: `${SIGNED_URL}&u=early` }),
      ],
      RUNGS,
    );
    assert.deepEqual(Object.keys(map), ["preset:best"]);
    assert.equal(map["preset:best"]?.playlistUrl, `${SIGNED_URL}&u=early`);
    assert.equal(map["preset:best"]?.height, null);
  });

  it("prefers a KNOWN-height candidate for preset:best over an unknown one", () => {
    // The fallback is exactly that — a fallback. A rung winner exists here, so
    // the unknown-height rendition must not take `preset:best` merely by being
    // earlier in the document.
    const map = buildClearHlsMediaPlaylistSelections(
      [
        candidate({ height: null, index: 0, playlistUrl: `${SIGNED_URL}&u=unknown` }),
        candidate({ height: 720, index: 1, playlistUrl: `${SIGNED_URL}&r=720` }),
      ],
      RUNGS,
    );
    assert.equal(map["preset:best"]?.playlistUrl, `${SIGNED_URL}&r=720`);
    assert.equal(map["preset:720"]?.playlistUrl, `${SIGNED_URL}&r=720`);
  });

  it("falls back for a known height beneath the lowest rung", () => {
    const map = buildClearHlsMediaPlaylistSelections([candidate({ height: 100 })], RUNGS);
    assert.deepEqual(Object.keys(map), ["preset:best"]);
    assert.equal(map["preset:best"]?.height, 100);
  });

  it("never emits an audio or MP3 key, whatever the candidates", () => {
    const map = buildClearHlsMediaPlaylistSelections(
      RUNGS.map((r, i) => candidate({ height: r.minHeight, index: i })).concat([
        candidate({ height: null, index: 99 }),
      ]),
      RUNGS,
    );
    for (const id of Object.keys(map)) {
      assert.match(id, CLEAR_HLS_SHADOW_PRESET_ID_PATTERN, `${id} is outside the video ladder`);
    }
    assert.equal(map["preset:audio"], undefined);
    assert.equal(map["preset:mp3"], undefined);
    assert.equal(CLEAR_HLS_SHADOW_PRESET_ID_PATTERN.test("preset:audio"), false);
    assert.equal(CLEAR_HLS_SHADOW_PRESET_ID_PATTERN.test("preset:mp3"), false);
    assert.match(CLEAR_HLS_SHADOW_BEST_PRESET_ID, CLEAR_HLS_SHADOW_PRESET_ID_PATTERN);
  });

  it("skips a rung whose id is outside the closed vocabulary, fail-closed", () => {
    // Unreachable from upstream data — the analyzer's ladder is an
    // application-owned literal — so this is a guard against a future edit.
    // The wrong key is dropped; it is never emitted, and it never throws.
    const map = buildClearHlsMediaPlaylistSelections(
      [candidate({ height: 1080 })],
      [{ minHeight: 1080, id: "preset:audio" }, { minHeight: 720, id: "720p" }],
    );
    assert.deepEqual(Object.keys(map), ["preset:best"]);
  });

  it("freezes the map and every selection in it", () => {
    const map = buildClearHlsMediaPlaylistSelections([candidate({ height: 1080 })], RUNGS);
    assert.equal(Object.isFrozen(map), true);
    const selection = map["preset:1080"];
    assert.ok(selection);
    assert.equal(Object.isFrozen(selection), true);
    assert.throws(() => {
      (selection as { playlistUrl: string }).playlistUrl = "https://attacker.invalid/x.m3u8";
    }, TypeError);
    assert.throws(() => {
      (map as Record<string, unknown>)["preset:audio"] = selection;
    }, TypeError);
    assert.equal(map["preset:1080"]?.playlistUrl, SIGNED_URL);
  });

  it("carries only the playlist URL and the height", () => {
    // No upstream `format_id`, no headers, no cookies, no referer, no
    // downloader options: the URL itself is the acquisition provenance.
    const map = buildClearHlsMediaPlaylistSelections([candidate({ height: 1080 })], RUNGS);
    assert.deepEqual(Object.keys(map["preset:1080"] ?? {}).sort(), ["height", "playlistUrl"]);
  });
});

// ── Inertness and placement (§17, §25) ───────────────────────────────────────

describe("clear-HLS selection vocabulary: the module is inert", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  /** The module with its prose removed, so a mention is not mistaken for a call. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export function acceptClearHlsPlaylistUrl"));
    assert.ok(source.includes("Activation"), "the prose is really there...");
    assert.equal(code.includes("Activation"), false, "...and comments should be gone");
  });

  it("names no network, DNS, filesystem, process or runtime facility", () => {
    for (const forbidden of [
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "node:tls",
      "node:child_process",
      "safeHttpRequest",
      "safeGet",
      "resolveSafeDestination",
      "assertSafeUrl",
      "lookupHost",
      "fetch(",
      "require(",
      "import(",
      "spawn",
      "yt-dlp",
      "ffmpeg",
      "process.env",
      "Date.now",
      "Math.random",
    ]) {
      assert.equal(code.includes(forbidden), false, `must not reference ${forbidden}`);
    }
  });

  it("imports only the byte helper and the application's static URL policy", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["node:buffer", "@/lib/validation/url"]);
  });

  it("calls no HLS preflight, acquisition or processing primitive", () => {
    for (const forbidden of [
      "hls-media-playlist",
      "hls-preflight",
      "hls-fragment-acquisition",
      "hls-processing",
      "preflightClearHlsMediaPlaylist",
      "acquireClearHlsTs",
      "processClearHlsTsToMp4",
    ]) {
      assert.equal(source.includes(forbidden), false, `must not name ${forbidden}`);
    }
  });

  it("lives in a Worker-private location, not a shared or browser one", () => {
    assert.ok(statSync(MODULE_PATH).isFile());
    const rel = relative(ROOT, MODULE_PATH).split("\\").join("/");
    assert.ok(rel.startsWith("src/worker/"), "the selection is not a public contract");
    assert.equal(rel.startsWith("src/shared/"), false);
    assert.equal(rel.startsWith("src/web/"), false);
  });
});
