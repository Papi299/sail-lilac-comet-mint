import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClearHlsPlaylistError,
  HLS_V1_ALLOWED_TAGS,
  HLS_V1_MAX_FRAGMENTS,
  HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES,
  HLS_V1_MAX_PLAYLIST_BYTES,
  parseClearHlsMediaPlaylist,
  type ClearHlsPlaylistRejection,
} from "./hls-media-playlist.ts";

/**
 * HLS-1: the closed clear-VOD media-playlist parser.
 *
 * Two things are being pinned here. First, that the approved v1 subset parses
 * into exactly the small model the transport needs and nothing more. Second —
 * and this is the larger half of the file — that EVERY construct outside that
 * subset fails closed, that no refusal ever echoes the document it refused, and
 * that the module stays inert: no I/O, and no Production caller.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE_PATH = join(ROOT, "src/worker/hls/hls-media-playlist.ts");

// ── Fixture construction ─────────────────────────────────────────────────────

/** A minimal, valid, clear VOD TS playlist with `count` fragments. */
function validPlaylist(
  count = 2,
  opts: { readonly extra?: readonly string[]; readonly references?: readonly string[] } = {},
): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    ...(opts.extra ?? []),
  ];
  for (let i = 0; i < count; i += 1) {
    lines.push("#EXTINF:10.0,");
    lines.push(opts.references?.[i] ?? `seg${i}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/**
 * A playlist whose header lines are given EXACTLY, with one valid fragment.
 *
 * `validPlaylist` seeds a version and a target duration, which would collide
 * with a case that is itself about one of those tags. This builder seeds
 * nothing.
 */
function playlistWithHeader(header: readonly string[]): string {
  return ["#EXTM3U", ...header, "#EXTINF:10.0,", "a.ts", "#EXT-X-ENDLIST"].join("\n");
}

/** Assert the parser refuses `input` for exactly `reason`. */
function refusedWith(input: string, reason: ClearHlsPlaylistRejection): ClearHlsPlaylistError {
  let thrown: unknown;
  try {
    parseClearHlsMediaPlaylist(input);
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown instanceof ClearHlsPlaylistError,
    `expected a ClearHlsPlaylistError, saw ${String(thrown)}`,
  );
  assert.equal(thrown.reason, reason);
  return thrown;
}

/**
 * Assert a refusal message leaks nothing from the document that caused it.
 *
 * The parser builds every message from a fixed table, so this is really a test
 * that the table is still the only source — a template literal reintroduced
 * anywhere would show up here.
 */
function leaksNothing(err: ClearHlsPlaylistError, ...secrets: readonly string[]): void {
  const text = `${err.message} ${err.stack ?? ""}`;
  for (const secret of secrets) {
    assert.equal(
      text.includes(secret),
      false,
      `refusal text must not echo ${secret.slice(0, 12)}…`,
    );
  }
}

// ── Positive: the approved subset (§25) ──────────────────────────────────────

describe("clear-HLS playlist parser: the approved v1 subset", () => {
  it("parses a minimal clear VOD TS playlist", () => {
    const plan = parseClearHlsMediaPlaylist(validPlaylist(3));
    assert.equal(plan.segmentType, "mpegts");
    assert.equal(plan.fragmentCount, 3);
    assert.deepEqual(
      plan.fragments.map((f) => f.reference),
      ["seg0.ts", "seg1.ts", "seg2.ts"],
    );
  });

  it("keeps fragments in playlist order", () => {
    const references = ["c.ts", "a.ts", "b.ts"];
    const plan = parseClearHlsMediaPlaylist(validPlaylist(3, { references }));
    assert.deepEqual([...plan.fragments.map((f) => f.reference)], references);
  });

  it("accepts CRLF line endings", () => {
    const crlf = validPlaylist(2).replace(/\n/g, "\r\n");
    const plan = parseClearHlsMediaPlaylist(crlf);
    assert.equal(plan.fragmentCount, 2);
    assert.deepEqual(
      plan.fragments.map((f) => f.reference),
      ["seg0.ts", "seg1.ts"],
    );
  });

  it("accepts every approved optional tag", () => {
    const plan = parseClearHlsMediaPlaylist(
      validPlaylist(2, {
        extra: ["#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0"],
      }),
    );
    assert.equal(plan.fragmentCount, 2);
  });

  it("accepts a large but safe media sequence without retaining it", () => {
    const plan = parseClearHlsMediaPlaylist(
      validPlaylist(1, { extra: ["#EXT-X-MEDIA-SEQUENCE:9007199254740"] }),
    );
    assert.equal(plan.fragmentCount, 1);
    // The model carries the fragment array and nothing else that could be used
    // for sequence arithmetic later.
    assert.deepEqual(Object.keys(plan).sort(), ["fragmentCount", "fragments", "segmentType"]);
  });

  it("accepts relative, absolute, query-bearing and signed-looking references", () => {
    const references = [
      "seg0.ts",
      "../media/seg1.ts",
      "/abs/path/seg2.ts",
      "https://cdn.example/seg3.ts",
      "http://cdn.example/seg4.ts?start=1&end=2",
      "https://cdn.example/seg5.ts?Expires=1758240000&Signature=abc~def_-&Key-Pair-Id=K123",
      "seg6.ts?token=a%2Fb%2Bc%3D",
    ];
    const plan = parseClearHlsMediaPlaylist(
      validPlaylist(references.length, { references }),
    );
    // Verbatim: a signed reference must never be trimmed, normalised or rewritten.
    assert.deepEqual([...plan.fragments.map((f) => f.reference)], references);
  });

  it("accepts integer and fractional EXTINF durations, with or without a title", () => {
    for (const extinf of ["#EXTINF:10,", "#EXTINF:10.0,", "#EXTINF:9.009,", "#EXTINF:10"]) {
      const source = ["#EXTM3U", "#EXT-X-TARGETDURATION:10", extinf, "a.ts", "#EXT-X-ENDLIST"].join("\n");
      assert.equal(parseClearHlsMediaPlaylist(source).fragmentCount, 1);
    }
  });

  it("never lets an EXTINF title reach the model", () => {
    const source = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,UPSTREAM-TITLE-SENTINEL",
      "a.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const plan = parseClearHlsMediaPlaylist(source);
    assert.equal(
      JSON.stringify(plan).includes("UPSTREAM-TITLE-SENTINEL"),
      false,
      "upstream title text must not reach the application model",
    );
  });

  it("ignores blank lines and ordinary comments", () => {
    const source = [
      "#EXTM3U",
      "",
      "# an ordinary comment",
      "#EXT-X-TARGETDURATION:10",
      "   ",
      "#EXTINF:10.0,",
      "a.ts",
      "# another comment",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");
    assert.equal(parseClearHlsMediaPlaylist(source).fragmentCount, 1);
  });

  it("accepts exactly HLS_V1_MAX_FRAGMENTS fragments", () => {
    const plan = parseClearHlsMediaPlaylist(validPlaylist(HLS_V1_MAX_FRAGMENTS));
    assert.equal(plan.fragmentCount, HLS_V1_MAX_FRAGMENTS);
    assert.equal(plan.fragments.length, HLS_V1_MAX_FRAGMENTS);
  });

  it("accepts a reference of exactly the maximum length", () => {
    const tail = "a".repeat(HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES - "https://cdn.example/".length);
    const reference = `https://cdn.example/${tail}`;
    assert.equal(Buffer.byteLength(reference, "utf8"), HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES);
    const plan = parseClearHlsMediaPlaylist(validPlaylist(1, { references: [reference] }));
    assert.equal(plan.fragments[0]?.reference, reference);
  });

  it("accepts a playlist of exactly the maximum byte size", () => {
    // The padding is a comment INSIDE the document: nothing but blank lines may
    // follow the terminator, so padding after it would be a second defect.
    const base = validPlaylist(1);
    const padding = HLS_V1_MAX_PLAYLIST_BYTES - Buffer.byteLength(base, "utf8") - 2;
    const source = validPlaylist(1, { extra: [`#${"p".repeat(padding)}`] });
    assert.equal(Buffer.byteLength(source, "utf8"), HLS_V1_MAX_PLAYLIST_BYTES);
    assert.equal(parseClearHlsMediaPlaylist(source).fragmentCount, 1);
  });
});

// ── The closed vocabulary (§15) ──────────────────────────────────────────────

describe("clear-HLS playlist parser: the closed tag vocabulary", () => {
  it("permits exactly the seven approved tags", () => {
    assert.deepEqual(
      [...HLS_V1_ALLOWED_TAGS],
      [
        "#EXTM3U",
        "#EXT-X-VERSION",
        "#EXT-X-TARGETDURATION",
        "#EXT-X-MEDIA-SEQUENCE",
        "#EXT-X-PLAYLIST-TYPE",
        "#EXTINF",
        "#EXT-X-ENDLIST",
      ],
    );
  });

  it("refuses every RFC 8216 tag outside the allowlist", () => {
    // Tags a general HLS reader would accept. Each must fail closed, whether it
    // carries a dedicated reason or falls to the generic one.
    const outside = [
      "#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"",
      "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"k.bin\"",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXT-X-BYTERANGE:1000@0",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-DISCONTINUITY-SEQUENCE:1",
      "#EXT-X-STREAM-INF:BANDWIDTH=1",
      "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\"",
      "#EXT-X-SESSION-DATA:DATA-ID=\"d\"",
      "#EXT-X-I-FRAMES-ONLY",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-START:TIME-OFFSET=0",
      "#EXT-X-DATERANGE:ID=\"d\"",
      "#EXT-X-GAP",
      "#EXT-X-BITRATE:1000",
      "#EXT-X-PART:URI=\"p.ts\",DURATION=1",
      "#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"p.ts\"",
      "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES",
      "#EXT-X-PROGRAM-DATE-TIME:2026-09-19T00:00:00Z",
      "#EXT-X-ALLOW-CACHE:NO",
      "#EXT-X-DEFINE:NAME=\"n\",VALUE=\"v\"",
      "#EXT-X-CONTENT-STEERING:SERVER-URI=\"s\"",
      "#EXT-X-NOT-A-REAL-TAG",
    ];
    for (const tag of outside) {
      let thrown: unknown;
      try {
        parseClearHlsMediaPlaylist(validPlaylist(1, { extra: [tag] }));
      } catch (err) {
        thrown = err;
      }
      assert.ok(
        thrown instanceof ClearHlsPlaylistError,
        `${tag.slice(0, 24)} must be refused`,
      );
    }
  });

  it("holds anything tag-shaped to the allowlist rather than treating it as a comment", () => {
    // A malformed or oddly-cased #EXT... line must not fall through the comment
    // door. Only lines that are not tag-shaped at all are ignorable prose.
    for (const line of ["#EXT-X-KEY", "#extinf:10.0,", "#Ext-X-Map:URI=\"i.mp4\"", "#EXT"]) {
      let thrown: unknown;
      try {
        parseClearHlsMediaPlaylist(validPlaylist(1, { extra: [line] }));
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof ClearHlsPlaylistError, `${line} must not be ignored`);
    }
  });
});

// ── Negative: everything outside the subset (§26) ────────────────────────────

describe("clear-HLS playlist parser: structural refusals", () => {
  it("refuses empty and non-text input", () => {
    refusedWith("", "empty");
    refusedWith(undefined as unknown as string, "not_text");
    refusedWith(null as unknown as string, "not_text");
    refusedWith(123 as unknown as string, "not_text");
    refusedWith({ toString: () => "#EXTM3U" } as unknown as string, "not_text");
  });

  it("refuses a document that does not begin with #EXTM3U", () => {
    refusedWith("#EXT-X-TARGETDURATION:10\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST", "missing_extm3u");
    refusedWith("not a playlist", "missing_extm3u");
    // Even a leading blank line: the header must be the literal first line.
    refusedWith(`\n${validPlaylist(1)}`, "missing_extm3u");
    refusedWith(` ${validPlaylist(1)}`, "missing_extm3u");
  });

  it("refuses a byte order mark", () => {
    refusedWith(`\uFEFF${validPlaylist(1)}`, "byte_order_mark");
  });

  it("refuses a bare CR rather than repairing it", () => {
    refusedWith(validPlaylist(1).replace(/\n/g, "\r"), "malformed_line_ending");
    refusedWith("#EXTM3U\r\n#EXT-X-TARGETDURATION:10\r#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n", "malformed_line_ending");
  });

  it("refuses control characters anywhere, including in a reference", () => {
    refusedWith(validPlaylist(1).replace("seg0.ts", "seg\u00000.ts"), "control_character");
    refusedWith(validPlaylist(1).replace("seg0.ts", "seg\u001b0.ts"), "control_character");
    refusedWith(validPlaylist(1).replace("seg0.ts", "seg\u007f0.ts"), "control_character");
    refusedWith(validPlaylist(1).replace("seg0.ts", "seg\t0.ts"), "control_character");
  });

  it("refuses a master playlist", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720",
      "v720.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080",
      "v1080.m3u8",
    ].join("\n");
    const err = refusedWith(master, "master_playlist");
    leaksNothing(err, "v720.m3u8", "v1080.m3u8", "BANDWIDTH");
  });

  it("refuses a playlist with no fragments", () => {
    refusedWith(
      ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXT-X-ENDLIST"].join("\n"),
      "no_fragments",
    );
  });

  it("refuses a playlist that is not terminated", () => {
    refusedWith(validPlaylist(2).replace("#EXT-X-ENDLIST\n", ""), "missing_endlist");
  });

  it("refuses a playlist with no target duration", () => {
    refusedWith(
      ["#EXTM3U", "#EXTINF:10.0,", "a.ts", "#EXT-X-ENDLIST"].join("\n"),
      "missing_targetduration",
    );
  });

  it("refuses live and event shapes", () => {
    refusedWith(validPlaylist(1, { extra: ["#EXT-X-PLAYLIST-TYPE:EVENT"] }), "live_or_event");
    refusedWith(validPlaylist(1, { extra: ["#EXT-X-PLAYLIST-TYPE:"] }), "live_or_event");
    refusedWith(validPlaylist(1, { extra: ["#EXT-X-PLAYLIST-TYPE:vod"] }), "live_or_event");
    // A live media playlist has no ENDLIST at all.
    refusedWith(
      ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:42", "#EXTINF:10.0,", "a.ts"].join("\n"),
      "missing_endlist",
    );
  });

  it("refuses anything after the terminator", () => {
    refusedWith(`${validPlaylist(1)}#EXTINF:10.0,\nlate.ts\n`, "content_after_endlist");
    refusedWith(`${validPlaylist(1)}late.ts\n`, "content_after_endlist");
    refusedWith(`${validPlaylist(1)}#EXT-X-ENDLIST\n`, "content_after_endlist");
  });

  it("accepts only blank lines after the terminator", () => {
    const closed = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST";
    // End of input, one terminal newline, and further blank or space-only lines
    // are ordinary text serialisation, not content.
    for (const source of [closed, `${closed}\n`, `${closed}\n\n   \n\n`, `${closed}\r\n\r\n`]) {
      assert.equal(parseClearHlsMediaPlaylist(source).fragmentCount, 1);
    }
  });

  it("refuses an ordinary comment after the terminator, without echoing it", () => {
    // The comment door must not reopen once the document is closed. Before
    // this was fixed, both of these were accepted as ignorable prose.
    const closed = validPlaylist(1);
    for (const comment of ["# trailing-comment-TRAILSENTINEL", "#not-an-ext-tag-TRAILSENTINEL"]) {
      const err = refusedWith(`${closed}${comment}\n`, "content_after_endlist");
      leaksNothing(err, "TRAILSENTINEL", "trailing-comment", "not-an-ext-tag");
    }
    // Trailing blank lines before the comment do not help it through.
    refusedWith(`${closed}\n\n# TRAILSENTINEL\n`, "content_after_endlist");
  });

  it("refuses a tag or arbitrary text after the terminator without interpreting it", () => {
    // Even a tag that would be refused on its own terms is not classified: it
    // is simply content after the end, and nothing after the end is read.
    for (const tail of [
      "#EXT-X-VERSION:3",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.example/TRAILSENTINEL\"",
      "arbitrary text TRAILSENTINEL",
    ]) {
      const err = refusedWith(`${validPlaylist(1)}${tail}\n`, "content_after_endlist");
      leaksNothing(err, "TRAILSENTINEL", "keys.example");
    }
  });
});

describe("clear-HLS playlist parser: encryption is categorically refused (§11)", () => {
  // Every one of these is refused on the SAME rule: a key line at all. None is
  // inspected for whether it "looks decryptable", and no key URI is retained.
  const keyLines = [
    "#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.example/k?KEYSENTINEL\"",
    "#EXT-X-KEY:METHOD=NONE",
    "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://KEYSENTINEL\"",
    "#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"KEYSENTINEL\"",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"KEYSENTINEL\",KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\",KEYFORMATVERSIONS=\"1\"",
    "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://KEYSENTINEL\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"KEYSENTINEL\",KEYFORMAT=\"com.microsoft.playready\"",
    "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"KEYSENTINEL\"",
  ];

  for (const line of keyLines) {
    const label = line.slice(0, 34);
    it(`refuses ${label}…`, () => {
      const err = refusedWith(validPlaylist(1, { extra: [line] }), "encrypted");
      leaksNothing(err, "KEYSENTINEL", "keys.example", "urn:uuid", "streamingkeydelivery", "playready");
    });
  }

  it("refuses a key line even after the fragments", () => {
    const source = validPlaylist(2).replace(
      "#EXT-X-ENDLIST",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"KEYSENTINEL\"\n#EXT-X-ENDLIST",
    );
    leaksNothing(refusedWith(source, "encrypted"), "KEYSENTINEL");
  });
});

describe("clear-HLS playlist parser: non-TS and range constructs (§12–§14)", () => {
  it("refuses an initialization map", () => {
    const err = refusedWith(
      validPlaylist(1, { extra: ["#EXT-X-MAP:URI=\"init-MAPSENTINEL.mp4\""] }),
      "initialization_map",
    );
    leaksNothing(err, "MAPSENTINEL");
  });

  it("refuses byte ranges", () => {
    refusedWith(validPlaylist(1, { extra: ["#EXT-X-BYTERANGE:75232@0"] }), "byte_range");
    // A byte range attaches to the fragment that follows it.
    const source = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,",
      "#EXT-X-BYTERANGE:75232@0",
      "a.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    refusedWith(source, "byte_range");
  });

  it("refuses discontinuities", () => {
    refusedWith(validPlaylist(1, { extra: ["#EXT-X-DISCONTINUITY"] }), "discontinuity");
    refusedWith(validPlaylist(1, { extra: ["#EXT-X-DISCONTINUITY-SEQUENCE:2"] }), "discontinuity");
  });
});

describe("clear-HLS playlist parser: bounds (§7, §17, §18)", () => {
  it("refuses more than HLS_V1_MAX_FRAGMENTS fragments", () => {
    refusedWith(validPlaylist(HLS_V1_MAX_FRAGMENTS + 1), "too_many_fragments");
  });

  it("refuses a playlist over the byte ceiling", () => {
    const base = validPlaylist(1);
    const padding = HLS_V1_MAX_PLAYLIST_BYTES - Buffer.byteLength(base, "utf8") - 1;
    const source = validPlaylist(1, { extra: [`#${"p".repeat(padding)}`] });
    assert.equal(Buffer.byteLength(source, "utf8"), HLS_V1_MAX_PLAYLIST_BYTES + 1);
    refusedWith(source, "too_large");
  });

  it("measures the ceiling in UTF-8 BYTES, not UTF-16 code units", () => {
    // Three bytes per character: a document whose `String.length` is comfortably
    // under the ceiling while its real size is far over it. A code-unit check
    // would admit this.
    const filler = "\u20ac".repeat(900_000);
    const source = validPlaylist(1, { extra: [`# ${filler}`] });
    assert.ok(source.length < HLS_V1_MAX_PLAYLIST_BYTES, "the code-unit count must look safe");
    assert.ok(Buffer.byteLength(source, "utf8") > HLS_V1_MAX_PLAYLIST_BYTES);
    refusedWith(source, "too_large");
  });

  it("refuses an overlong fragment reference", () => {
    const tail = "a".repeat(HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES - "https://cdn.example/".length + 1);
    const reference = `https://cdn.example/${tail}`;
    assert.equal(Buffer.byteLength(reference, "utf8"), HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES + 1);
    const err = refusedWith(
      validPlaylist(1, { references: [reference] }),
      "fragment_reference_too_long",
    );
    leaksNothing(err, tail.slice(0, 64));
  });

  it("refuses references the URI grammar does not admit", () => {
    for (const reference of [
      "seg 0.ts",
      "seg\\0.ts",
      "seg0.ts#frag",
      "seg\u00fc0.ts",
      "seg<0>.ts",
      "seg\"0\".ts",
      "seg{0}.ts",
      "seg|0.ts",
      " seg0.ts",
      "seg0.ts ",
    ]) {
      const source = ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXTINF:10.0,", reference, "#EXT-X-ENDLIST"].join("\n");
      let thrown: unknown;
      try {
        parseClearHlsMediaPlaylist(source);
      } catch (err) {
        thrown = err;
      }
      assert.ok(
        thrown instanceof ClearHlsPlaylistError,
        `reference ${JSON.stringify(reference)} must be refused`,
      );
      leaksNothing(thrown, reference.trim());
    }
  });
});

describe("clear-HLS playlist parser: fragment association (§18)", () => {
  it("refuses a fragment with no EXTINF before it", () => {
    const source = ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "orphan.ts", "#EXT-X-ENDLIST"].join("\n");
    leaksNothing(refusedWith(source, "fragment_without_extinf"), "orphan.ts");
  });

  it("refuses a second fragment that reuses the first EXTINF", () => {
    const source = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,",
      "a.ts",
      "b.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    refusedWith(source, "fragment_without_extinf");
  });

  it("refuses a dangling EXTINF", () => {
    refusedWith(
      ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXTINF:10.0,", "a.ts", "#EXTINF:10.0,", "#EXT-X-ENDLIST"].join("\n"),
      "extinf_without_fragment",
    );
    // …including one at the very end, with no terminator after it.
    refusedWith(
      ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXTINF:10.0,", "a.ts", "#EXTINF:10.0,"].join("\n"),
      "extinf_without_fragment",
    );
    // …and two in a row.
    refusedWith(
      ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXTINF:10.0,", "#EXTINF:10.0,", "a.ts", "#EXT-X-ENDLIST"].join("\n"),
      "extinf_without_fragment",
    );
  });
});

describe("clear-HLS playlist parser: tag values and duplicates (§19–§21)", () => {
  it("refuses malformed EXTINF durations", () => {
    for (const extinf of [
      "#EXTINF",
      "#EXTINF:",
      "#EXTINF:,",
      "#EXTINF:abc,",
      "#EXTINF:-1,",
      "#EXTINF:1e3,",
      "#EXTINF:.5,",
      "#EXTINF:+1,",
      "#EXTINF:Infinity,",
      "#EXTINF:NaN,",
      "#EXTINF:99999999.0,",
      "#EXTINF:1.2.3,",
    ]) {
      const source = ["#EXTM3U", "#EXT-X-TARGETDURATION:10", extinf, "a.ts", "#EXT-X-ENDLIST"].join("\n");
      let thrown: unknown;
      try {
        parseClearHlsMediaPlaylist(source);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof ClearHlsPlaylistError, `${extinf} must be refused`);
    }
  });

  it("refuses malformed numeric tag values", () => {
    // Each case supplies the WHOLE header, so the malformed tag is the only
    // thing wrong with the document and cannot be masked by a duplicate.
    for (const header of [
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-VERSION:abc"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-VERSION:0"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-VERSION:-3"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-VERSION:99"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-VERSION:"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-VERSION:3.0"],
      ["#EXT-X-TARGETDURATION:0"],
      ["#EXT-X-TARGETDURATION:abc"],
      ["#EXT-X-TARGETDURATION:10.5"],
      ["#EXT-X-TARGETDURATION:"],
      ["#EXT-X-TARGETDURATION:999999"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:-1"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:abc"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:99999999999999999999"],
      ["#EXT-X-TARGETDURATION:10", "#EXT-X-ENDLIST:something"],
    ]) {
      refusedWith(playlistWithHeader(header), "malformed_tag_value");
    }
  });

  it("refuses a digit run long enough to lose integer precision", () => {
    // 9007199254740993 is the first integer a double cannot represent. The
    // digit-count bound refuses it before `Number` gets the chance to round it.
    refusedWith(
      playlistWithHeader(["#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:9007199254740993"]),
      "malformed_tag_value",
    );
  });

  it("refuses a repeated single-occurrence tag, agreeing or not", () => {
    for (const tag of [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
    ]) {
      refusedWith(playlistWithHeader(["#EXT-X-TARGETDURATION:10", tag, tag]), "duplicate_tag");
    }
    // A contradicting repeat is refused on the same rule, not resolved.
    refusedWith(
      playlistWithHeader(["#EXT-X-TARGETDURATION:10", "#EXT-X-TARGETDURATION:99"]),
      "duplicate_tag",
    );
  });

  it("allows EXTINF to repeat, because every fragment needs one", () => {
    assert.equal(parseClearHlsMediaPlaylist(validPlaylist(5)).fragmentCount, 5);
  });
});

// ── Immutability (§23) ───────────────────────────────────────────────────────

describe("clear-HLS playlist parser: the plan is immutable", () => {
  it("freezes the plan, the fragment collection and every entry", () => {
    const plan = parseClearHlsMediaPlaylist(validPlaylist(3));
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.fragments));
    for (const fragment of plan.fragments) assert.ok(Object.isFrozen(fragment));
  });

  it("cannot be edited by a caller between approval and acquisition", () => {
    const plan = parseClearHlsMediaPlaylist(validPlaylist(2));
    const mutable = plan as unknown as {
      segmentType: string;
      fragmentCount: number;
      fragments: { reference: string }[];
    };

    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch {
        // Strict mode throws; sloppy mode is silent. The assertion that matters
        // is the value afterwards, so either outcome is acceptable here.
      }
    };

    attempt(() => {
      mutable.segmentType = "fmp4";
    });
    attempt(() => {
      mutable.fragmentCount = 99;
    });
    attempt(() => {
      mutable.fragments.push({ reference: "injected.ts" });
    });
    attempt(() => {
      mutable.fragments[0] = { reference: "swapped.ts" };
    });
    attempt(() => {
      const first = mutable.fragments[0];
      if (first) first.reference = "rewritten.ts";
    });

    assert.equal(plan.segmentType, "mpegts");
    assert.equal(plan.fragmentCount, 2);
    assert.equal(plan.fragments.length, 2);
    assert.deepEqual(
      plan.fragments.map((f) => f.reference),
      ["seg0.ts", "seg1.ts"],
    );
  });
});

// ── Inertness: no I/O, no Production caller (§24, M8) ────────────────────────

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

describe("clear-HLS playlist parser: the module is inert", () => {
  const source = readFileSync(MODULE_PATH, "utf8");

  /**
   * The module with its prose removed.
   *
   * The comments deliberately DISCUSS yt-dlp, FFmpeg and the transport, because
   * that is where the reasoning belongs. Scanning raw text would confuse a
   * mention with a call, so the forbidden-name check runs against code only.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export function parseClearHlsMediaPlaylist"));
    assert.equal(code.includes("§11"), false, "comments should be gone");
  });

  it("imports nothing capable of I/O", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    // The single permitted import is a pure encoding utility: it is how the
    // 2 MiB ceiling is measured in real UTF-8 bytes rather than code units.
    assert.deepEqual(imports, ["node:buffer"]);
  });

  it("names no network, filesystem, process or runtime facility", () => {
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
      "safeHttpRequest",
      "resolveSafeDestination",
      "assertSafeUrl",
      "fetch(",
      "require(",
      "import(",
      "XMLHttpRequest",
      "spawn",
      "exec",
      "yt-dlp",
      "ffmpeg",
      "ffprobe",
      "process.env",
      "Date.now",
      "Math.random",
    ]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `the parser must not reference ${forbidden}`,
      );
    }
  });

  it("is reachable from no production module", () => {
    // HLS stays dormant: the parser exists, and nothing in the shipping graph
    // can call it. Its importers are its dormant siblings in `src/worker/hls/`
    // (HLS-2 onwards), so the rule is held by that directory as a SET: no
    // production module outside it may name ANY module in it. The later atomic
    // activation task is what changes this.
    //
    // TWO narrow exceptions, and no others.
    //
    // (1) HLS-5 added `hls-source-selection`: the dormant channel's SOURCE end,
    //     not part of its execution capability. It is a pure vocabulary that
    //     turns one already-parsed yt-dlp format into a private media-playlist
    //     URL on an application-owned preset rung. It holds no acquisition, no
    //     processing, no I/O and no HLS import of its own, so naming it cannot
    //     make HLS reachable. Analysis MUST name it, and HLS-6 added the
    //     execution planner, which needs its URL-acceptance policy to validate
    //     a retained selection before that selection may authorise a request.
    //
    // (2) HLS-6 added `hls-execution.server`: the ONE orchestration seam, and
    //     the ONLY module outside this directory's own siblings that may reach
    //     an HLS execution primitive. It exists so the JobExecutor never names
    //     HLS-2, HLS-3 or HLS-4 and never learns a private HLS failure enum.
    //
    // Both allowlists are EXACT, in both directions: only these files may name
    // these stems, and these files may name NOTHING else from this directory.
    // Reachability from the executor is expected after HLS-6 — dormancy is now
    // held at plan derivation, which `hls-shadow-selection.server.test.ts` pins
    // — but the graph must still narrow to exactly these edges.
    const hlsDir = dirname(MODULE_PATH);
    const dormantModules = readdirSync(hlsDir)
      .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
      .map((name) => name.replace(/\.ts$/, ""));
    assert.ok(dormantModules.includes("hls-media-playlist"));
    assert.ok(dormantModules.includes("hls-source-selection"));
    assert.ok(dormantModules.includes("hls-execution.server"));

    /** stem -> the only production modules permitted to name it. */
    const ALLOWED_IMPORTERS = new Map<string, ReadonlySet<string>>([
      [
        "hls-source-selection",
        new Set([
          "src/worker/analysis/ytdlp-analysis.server.ts",
          "src/worker/analysis/media-analyzer.server.ts",
          "src/worker/execution/format-plan.ts",
        ]),
      ],
      ["hls-execution.server", new Set(["src/worker/execution/job-executor.server.ts"])],
    ]);

    for (const file of productionSourceFiles()) {
      if (dirname(file) === hlsDir) continue;
      const rel = relative(ROOT, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      for (const stem of dormantModules) {
        if (ALLOWED_IMPORTERS.get(stem)?.has(rel)) continue;
        assert.equal(
          source.includes(stem),
          false,
          `${rel} must not import the dormant HLS module ${stem}`,
        );
      }
    }

    // The exceptions are not loopholes: each allowed importer may name its OWN
    // stem and nothing else from this directory.
    for (const [allowedStem, importers] of ALLOWED_IMPORTERS) {
      for (const rel of importers) {
        const source = readFileSync(join(ROOT, rel), "utf8");
        for (const stem of dormantModules) {
          if (stem === allowedStem) continue;
          if (ALLOWED_IMPORTERS.get(stem)?.has(rel)) continue;
          assert.equal(source.includes(stem), false, `${rel} must not name ${stem}`);
        }
      }
    }
    assert.match(
      readFileSync(join(ROOT, "src/worker/analysis/media-analyzer.server.ts"), "utf8"),
      /import type \{ ClearHlsMediaPlaylistSelections \} from "\.\.\/hls\/hls-source-selection\.ts";/,
      "the router's HLS edge must be type-only",
    );
  });

  it("lives in a Worker-private location, not a shared or browser one", () => {
    assert.ok(statSync(MODULE_PATH).isFile());
    const rel = relative(ROOT, MODULE_PATH).split("\\").join("/");
    assert.ok(rel.startsWith("src/worker/"), "the model is not a public contract");
    assert.equal(rel.startsWith("src/shared/"), false);
  });
});
