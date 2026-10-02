import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClearHlsMasterPlaylistError,
  HLS_MASTER_ALLOWED_TAGS,
  HLS_MASTER_MAX_ATTRIBUTES,
  HLS_MASTER_MAX_LINE_BYTES,
  HLS_MASTER_MAX_PLAYLIST_BYTES,
  HLS_MASTER_MAX_RENDITIONS,
  HLS_MASTER_MAX_VARIANTS,
  isJoinStableReference,
  parseClearHlsMasterPlaylist,
  type ClearHlsMasterRejection,
} from "./hls-master-playlist.ts";
import { ClearHlsPlaylistError, parseClearHlsMediaPlaylist } from "./hls-media-playlist.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: the closed master grammar.
 *
 * Every refusal is checked by its private reason, so a test cannot pass
 * because the parser refused for some other, accidental reason.
 */

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "hls-master-playlist.ts");

const MEDIA = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES,AUTOSELECT=YES,URI="audio/main.m3u8"';
const VARIANT = '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"';

function master(...lines: string[]): string {
  return ["#EXTM3U", ...lines, ""].join("\n");
}

const VALID = master("#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS", MEDIA, VARIANT, "video/1080.m3u8");

function refusal(text: string): ClearHlsMasterRejection {
  try {
    parseClearHlsMasterPlaylist(text);
  } catch (err) {
    assert.ok(err instanceof ClearHlsMasterPlaylistError, `expected a master refusal, got ${String(err)}`);
    return err.reason;
  }
  assert.fail("the document was accepted");
}

function expectRefusal(text: string, reason: ClearHlsMasterRejection): void {
  assert.equal(refusal(text), reason);
}

describe("clear-HLS master parser: the approved relationship", () => {
  it("reads one variant, its AUDIO group index and the group's one URI rendition", () => {
    const model = parseClearHlsMasterPlaylist(VALID);
    assert.deepEqual(JSON.parse(JSON.stringify(model)), {
      variants: [{ reference: "video/1080.m3u8", audioGroup: 0, resolution: { width: 1920, height: 1080 } }],
      audioGroups: [[{ reference: "audio/main.m3u8" }]],
    });
  });

  it("freezes the model, its collections and every entry", () => {
    const model = parseClearHlsMasterPlaylist(VALID);
    assert.ok(Object.isFrozen(model));
    assert.ok(Object.isFrozen(model.variants));
    assert.ok(Object.isFrozen(model.variants[0]));
    assert.ok(Object.isFrozen(model.variants[0]!.resolution));
    assert.ok(Object.isFrozen(model.audioGroups));
    assert.ok(Object.isFrozen(model.audioGroups[0]));
    assert.ok(Object.isFrozen(model.audioGroups[0]![0]));
  });

  it("keeps NO group id, NAME, LANGUAGE, CHANNELS, CODECS or bandwidth: groups are positions", () => {
    const text = master(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="GROUP_SENTINEL",NAME="NAME_SENTINEL",LANGUAGE="LANG_SENTINEL",CHANNELS="2",URI="a.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=123456789,AVERAGE-BANDWIDTH=111,FRAME-RATE=29.970,CODECS="avc1.CODEC_SENTINEL",AUDIO="GROUP_SENTINEL"',
      "v.m3u8",
    );
    const serialized = JSON.stringify(parseClearHlsMasterPlaylist(text));
    for (const needle of ["GROUP_SENTINEL", "NAME_SENTINEL", "LANG_SENTINEL", "CODEC_SENTINEL", "123456789", "29.970", "\"2\""]) {
      assert.equal(serialized.includes(needle), false, needle);
    }
  });

  it("indexes groups by first appearance and resolves AUDIO references declared before or after the variant", () => {
    const model = parseClearHlsMasterPlaylist(
      master(
        '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f",AUDIO="lo"',
        "v720.m3u8",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hi",NAME="a",URI="hi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="lo",NAME="a",URI="lo.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2,CODECS="avc1.640028",AUDIO="hi"',
        "v1080.m3u8",
      ),
    );
    assert.deepEqual(
      model.variants.map((v) => [v.reference, v.audioGroup]),
      [["v720.m3u8", 1], ["v1080.m3u8", 0]],
    );
    assert.deepEqual(model.audioGroups.map((g) => g.map((r) => r.reference)), [["hi.m3u8"], ["lo.m3u8"]]);
  });

  it("records a URI-less member as in-band (null) rather than dropping it", () => {
    const model = parseClearHlsMasterPlaylist(
      master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="in"', VARIANT, "v.m3u8"),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(model.audioGroups)), [[{ reference: null }]]);
  });

  it("admits a variant with no AUDIO group (audioGroup null) and no RESOLUTION (resolution null)", () => {
    const model = parseClearHlsMasterPlaylist(master("#EXT-X-STREAM-INF:BANDWIDTH=1", "v.m3u8"));
    assert.deepEqual(JSON.parse(JSON.stringify(model.variants)), [{ reference: "v.m3u8", audioGroup: null, resolution: null }]);
  });

  it("accepts CRLF, blank lines, prose comments and absolute / root-relative / signed references", () => {
    const text = [
      "#EXTM3U",
      "# a prose comment",
      "",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="m",URI="https://cdn.example.com/a/main.m3u8?tok=A1&exp=99"',
      VARIANT,
      "",
      "/root/v.m3u8?sig=abc~def*ghi",
      "",
    ].join("\r\n");
    const model = parseClearHlsMasterPlaylist(text);
    assert.equal(model.variants[0]!.reference, "/root/v.m3u8?sig=abc~def*ghi");
    assert.equal(model.audioGroups[0]![0]!.reference, "https://cdn.example.com/a/main.m3u8?tok=A1&exp=99");
  });

  it("states exactly five tags in its vocabulary", () => {
    assert.deepEqual([...HLS_MASTER_ALLOWED_TAGS], [
      "#EXTM3U",
      "#EXT-X-VERSION",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-MEDIA",
      "#EXT-X-STREAM-INF",
    ]);
  });
});

describe("clear-HLS master parser: document-level refusals", () => {
  it("refuses non-text, empty, BOM, bare CR and control characters", () => {
    expectRefusal(42 as unknown as string, "not_text");
    expectRefusal("", "empty");
    expectRefusal("﻿" + VALID, "byte_order_mark");
    expectRefusal(VALID.replace("\n#EXT-X-VERSION", "\r#EXT-X-VERSION"), "malformed_line_ending");
    expectRefusal(VALID.replace("video/1080", "video\t/1080"), "control_character");
    expectRefusal(VALID.replace("video/1080", `video${String.fromCharCode(0x7f)}/1080`), "control_character");
  });

  it("refuses a document over the 256 KiB master ceiling, and admits one exactly at it", () => {
    // Comment lines under the line bound pad the valid master to EXACTLY the
    // ceiling; one more byte is refused before any line is read.
    const lines: string[] = [];
    let remaining = HLS_MASTER_MAX_PLAYLIST_BYTES - Buffer.byteLength(VALID, "utf8");
    while (remaining > 0) {
      const size = Math.min(remaining, 4000);
      lines.push("#" + "x".repeat(size - 2));
      remaining -= size;
    }
    const atLimit = VALID + lines.join("\n") + "\n";
    assert.equal(Buffer.byteLength(atLimit, "utf8"), HLS_MASTER_MAX_PLAYLIST_BYTES);
    assert.doesNotThrow(() => parseClearHlsMasterPlaylist(atLimit));
    expectRefusal(atLimit + "#", "too_large");
    // Measured in UTF-8 bytes, not code units.
    expectRefusal(atLimit.slice(0, -2) + "é\n", "too_large");
  });

  it("refuses an overlong line", () => {
    expectRefusal(VALID + "# " + "x".repeat(HLS_MASTER_MAX_LINE_BYTES), "line_too_long");
  });

  it("requires #EXTM3U as the literal first line, once", () => {
    expectRefusal(VALID.replace("#EXTM3U\n", ""), "missing_extm3u");
    expectRefusal("\n" + VALID, "missing_extm3u");
    expectRefusal(VALID + "#EXTM3U\n", "duplicate_tag");
  });

  it("refuses every media-playlist construct: a document is never both", () => {
    for (const tag of [
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXTINF:4.0,",
      "#EXT-X-ENDLIST",
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="k"',
      "#EXT-X-BYTERANGE:10@0",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-I-FRAMES-ONLY",
      "#EXT-X-PART-INF:PART-TARGET=1",
    ]) {
      expectRefusal(master(tag, VARIANT, "v.m3u8"), "media_playlist");
    }
  });

  it("is refused by the MEDIA parser in turn, and refuses a real media playlist itself", () => {
    // A master handed to the media grammar.
    assert.throws(
      () => parseClearHlsMediaPlaylist(VALID),
      (err: unknown) => err instanceof ClearHlsPlaylistError && err.reason === "master_playlist",
    );
    // A media playlist handed to the master grammar.
    const media = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:1",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:1.0,",
      "seg-0.m4s",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");
    assert.doesNotThrow(() => parseClearHlsMediaPlaylist(media));
    expectRefusal(media, "media_playlist");
  });

  it("refuses master constructs outside the grammar by name", () => {
    for (const tag of [
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.x",VALUE="y"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="k"',
      '#EXT-X-CONTENT-STEERING:SERVER-URI="s"',
      '#EXT-X-DEFINE:NAME="x",VALUE="y"',
      "#EXT-X-START:TIME-OFFSET=0",
    ]) {
      expectRefusal(master(tag, VARIANT, "v.m3u8"), "refused_tag");
    }
  });

  it("holds anything tag-shaped to the vocabulary", () => {
    expectRefusal(master("#EXT-X-FUTURE-TAG:1", "#EXT-X-STREAM-INF:BANDWIDTH=1", "v.m3u8"), "unknown_tag");
    expectRefusal(master("#ext-x-stream-inf:BANDWIDTH=1", "v.m3u8"), "unknown_tag");
  });

  it("allows VERSION and INDEPENDENT-SEGMENTS once each, with exact values", () => {
    expectRefusal(master("#EXT-X-VERSION:7", "#EXT-X-VERSION:7", VARIANT, "v.m3u8"), "duplicate_tag");
    expectRefusal(master("#EXT-X-VERSION:0", VARIANT, "v.m3u8"), "malformed_tag_value");
    expectRefusal(master("#EXT-X-VERSION:11", VARIANT, "v.m3u8"), "malformed_tag_value");
    expectRefusal(master("#EXT-X-VERSION", VARIANT, "v.m3u8"), "malformed_tag_value");
    expectRefusal(master("#EXT-X-INDEPENDENT-SEGMENTS:YES", VARIANT, "v.m3u8"), "malformed_tag_value");
    expectRefusal(
      master("#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-INDEPENDENT-SEGMENTS", VARIANT, "v.m3u8"),
      "duplicate_tag",
    );
  });

  it("binds a variant tag to the URI line that immediately follows it", () => {
    expectRefusal(master(MEDIA, VARIANT), "stream_inf_without_uri");
    expectRefusal(master(MEDIA, VARIANT, MEDIA, "v.m3u8"), "stream_inf_without_uri");
    expectRefusal(master(MEDIA, VARIANT, "# a comment", "v.m3u8"), "stream_inf_without_uri");
    expectRefusal(master(MEDIA, "v.m3u8", VARIANT, "w.m3u8"), "uri_without_stream_inf");
    expectRefusal(master(MEDIA, VARIANT, "v.m3u8", "w.m3u8"), "uri_without_stream_inf");
  });

  it("requires at least one variant and bounds variants and renditions", () => {
    expectRefusal(master(MEDIA), "no_variants");
    const variants = Array.from({ length: HLS_MASTER_MAX_VARIANTS + 1 }, (_, i) => [
      "#EXT-X-STREAM-INF:BANDWIDTH=1",
      `v${i}.m3u8`,
    ]).flat();
    expectRefusal(master(...variants), "too_many_variants");
    assert.doesNotThrow(() => parseClearHlsMasterPlaylist(master(...variants.slice(0, HLS_MASTER_MAX_VARIANTS * 2))));
    const renditions = Array.from(
      { length: HLS_MASTER_MAX_RENDITIONS + 1 },
      (_, i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g${i}",NAME="n",URI="a${i}.m3u8"`,
    );
    expectRefusal(master(...renditions, "#EXT-X-STREAM-INF:BANDWIDTH=1", "v.m3u8"), "too_many_renditions");
  });
});

describe("clear-HLS master parser: attribute lists", () => {
  it("refuses malformed GROUP-ID quoting", () => {
    expectRefusal(master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=aud,NAME="m",URI="a.m3u8"', VARIANT, "v.m3u8"), "malformed_attribute_value");
    expectRefusal(master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud,NAME="m",URI="a.m3u8"', VARIANT, "v.m3u8"), "malformed_attribute_list");
    expectRefusal(master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="",NAME="m",URI="a.m3u8"', VARIANT, "v.m3u8"), "malformed_attribute_value");
    expectRefusal(master(MEDIA, VARIANT.replace('AUDIO="aud"', "AUDIO=aud"), "v.m3u8"), "malformed_attribute_value");
  });

  it("refuses malformed attribute lists", () => {
    for (const value of [
      "BANDWIDTH=1,",
      ",BANDWIDTH=1",
      "BANDWIDTH=1,,AUDIO=\"a\"",
      "BANDWIDTH",
      "bandwidth=1",
      "BANDWIDTH=1 ,CODECS=\"a\"",
      "",
    ]) {
      expectRefusal(master(`#EXT-X-STREAM-INF:${value}`, "v.m3u8"), "malformed_attribute_list");
    }
    expectRefusal(master("#EXT-X-STREAM-INF", "v.m3u8"), "malformed_attribute_list");
  });

  it("refuses a repeated attribute, load-bearing or not", () => {
    expectRefusal(master(MEDIA, VARIANT + ',AUDIO="aud"', "v.m3u8"), "duplicate_attribute");
    expectRefusal(master(MEDIA + ',URI="b.m3u8"', VARIANT, "v.m3u8"), "duplicate_attribute");
    expectRefusal(master(MEDIA + ',GROUP-ID="aud"', VARIANT, "v.m3u8"), "duplicate_attribute");
    expectRefusal(master(MEDIA, "#EXT-X-STREAM-INF:BANDWIDTH=1,BANDWIDTH=2", "v.m3u8"), "duplicate_attribute");
  });

  it("bounds the attribute count", () => {
    const many = Array.from({ length: HLS_MASTER_MAX_ATTRIBUTES + 1 }, (_, i) => `X${i}=1`).join(",");
    expectRefusal(master(`#EXT-X-STREAM-INF:${many}`, "v.m3u8"), "too_many_attributes");
  });

  it("refuses every variant attribute outside the closed set", () => {
    for (const extra of [
      'SUBTITLES="s"',
      "CLOSED-CAPTIONS=NONE",
      'VIDEO="v"',
      "HDCP-LEVEL=NONE",
      "VIDEO-RANGE=SDR",
      "PROGRAM-ID=1",
      'SUPPLEMENTAL-CODECS="dvh1"',
      "SCORE=1.0",
    ]) {
      expectRefusal(master(MEDIA, `${VARIANT},${extra}`, "v.m3u8"), "unsupported_attribute");
    }
  });

  it("refuses every rendition attribute outside the closed set", () => {
    for (const extra of ["FORCED=NO", 'INSTREAM-ID="CC1"', 'CHARACTERISTICS="x"', 'STABLE-RENDITION-ID="r"']) {
      expectRefusal(master(`${MEDIA},${extra}`, VARIANT, "v.m3u8"), "unsupported_attribute");
    }
  });

  it("type-checks every admitted value", () => {
    for (const variant of [
      "#EXT-X-STREAM-INF:BANDWIDTH=abc",
      "#EXT-X-STREAM-INF:BANDWIDTH=1234567890123",
      "#EXT-X-STREAM-INF:BANDWIDTH=1,AVERAGE-BANDWIDTH=-1",
      "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920*1080",
      "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=0x1080",
      "#EXT-X-STREAM-INF:BANDWIDTH=1,FRAME-RATE=fast",
      '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1, mp4a"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1;mp4a"',
      "#EXT-X-STREAM-INF:BANDWIDTH=\"1\"",
    ]) {
      expectRefusal(master(variant, "v.m3u8"), "malformed_attribute_value");
    }
    expectRefusal(master(`${MEDIA.replace("DEFAULT=YES", "DEFAULT=MAYBE")}`, VARIANT, "v.m3u8"), "malformed_attribute_value");
    expectRefusal(master(`${MEDIA.replace('NAME="main"', 'NAME="{$x}"')}`, VARIANT, "v.m3u8"), "malformed_attribute_value");
    expectRefusal(master(`${MEDIA},LANGUAGE="${"x".repeat(257)}"`, VARIANT, "v.m3u8"), "malformed_attribute_value");
  });

  it("requires BANDWIDTH on a variant and TYPE, GROUP-ID and NAME on a rendition", () => {
    expectRefusal(master('#EXT-X-STREAM-INF:CODECS="avc1"', "v.m3u8"), "missing_attribute");
    expectRefusal(master('#EXT-X-MEDIA:GROUP-ID="aud",NAME="m",URI="a.m3u8"', VARIANT, "v.m3u8"), "missing_attribute");
    expectRefusal(master('#EXT-X-MEDIA:TYPE=AUDIO,NAME="m",URI="a.m3u8"', VARIANT, "v.m3u8"), "missing_attribute");
    expectRefusal(master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="a.m3u8"', VARIANT, "v.m3u8"), "missing_attribute");
  });
});

describe("clear-HLS master parser: renditions and groups", () => {
  it("refuses every non-AUDIO rendition, so none can stand in as the audio source", () => {
    for (const type of ["VIDEO", "SUBTITLES", "CLOSED-CAPTIONS", "audio", "TEXT"]) {
      expectRefusal(master(MEDIA.replace("TYPE=AUDIO", `TYPE=${type}`), VARIANT, "v.m3u8"), "unsupported_rendition_type");
    }
  });

  it("refuses an AUDIO reference to an undeclared group", () => {
    expectRefusal(master(MEDIA, VARIANT.replace('AUDIO="aud"', 'AUDIO="other"'), "v.m3u8"), "missing_audio_group");
    expectRefusal(master(VARIANT, "v.m3u8"), "missing_audio_group");
  });

  it("refuses a grouped variant that declares no CODECS (RFC 8216 §4.3.4.2)", () => {
    expectRefusal(master(MEDIA, '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"', "v.m3u8"), "variant_without_codecs");
  });

  it("refuses an inconsistent group: a repeated NAME, two DEFAULTs, DEFAULT without AUTOSELECT", () => {
    expectRefusal(
      master(MEDIA, '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",URI="b.m3u8"', VARIANT, "v.m3u8"),
      "malformed_rendition_group",
    );
    expectRefusal(
      master(MEDIA, '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="alt",DEFAULT=YES,URI="b.m3u8"', VARIANT, "v.m3u8"),
      "malformed_rendition_group",
    );
    expectRefusal(master(MEDIA.replace("AUTOSELECT=YES", "AUTOSELECT=NO"), VARIANT, "v.m3u8"), "malformed_rendition_group");
  });

  it("parses (but does not resolve) a group with several members, leaving ambiguity to the proof", () => {
    const model = parseClearHlsMasterPlaylist(
      master(MEDIA, '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="alt",URI="alt.m3u8"', VARIANT, "v.m3u8"),
    );
    assert.equal(model.audioGroups[0]!.length, 2);
  });
});

describe("clear-HLS master parser: the join-stable URI subset", () => {
  const ADMITTED = [
    "v.m3u8",
    "a/b/v.m3u8",
    "/root/v.m3u8",
    "v.m3u8?tok=A1&exp=99",
    "v.m3u8?x=a/b?c",
    "v%7Eid/1080.m3u8",
    "v-1_2.3~x/(a)!$*+,=.m3u8",
    "https://cdn.example.com/a/v.m3u8",
    "https://cdn.example.com:8443/a/v.m3u8?s=1",
    "http://cdn.example.com/v.m3u8",
    "...m3u8",
  ];
  const REFUSED = [
    "",
    "./v.m3u8",
    "../v.m3u8",
    "a/./v.m3u8",
    "a/../v.m3u8",
    "a//v.m3u8",
    "a/b/",
    "/",
    "//cdn.example.com/v.m3u8",
    "v.m3u8?",
    "v.m3u8;p=1",
    "v.m3u8;",
    "v.m3u8#frag",
    "?q=1",
    "%2e/v.m3u8",
    "a/%2E%2e/v.m3u8",
    "v%zz.m3u8",
    "x:y/v.m3u8",
    "http:v.m3u8",
    "HTTPS://cdn.example.com/v.m3u8",
    "https://CDN.example.com/v.m3u8",
    "https://cdn.example.com:443/v.m3u8",
    "https://cdn.example.com",
    "https://cdn.example.com?x=1",
    "https://cdn.example.com//v.m3u8",
    "https://cdn.example.com/v.m3u8?",
    "ftp://cdn.example.com/v.m3u8",
    "https://user@cdn.example.com/v.m3u8",
    "v'.m3u8",
    "[v].m3u8",
    "v m3u8",
    "v\\x.m3u8",
    "v\".m3u8",
    "vé.m3u8",
    "{$x}.m3u8",
  ];

  it("admits ordinary relative, root-relative, absolute and signed references", () => {
    for (const ref of ADMITTED) assert.equal(isJoinStableReference(ref), true, ref);
  });

  it("refuses every spelling the two resolvers can disagree on", () => {
    for (const ref of REFUSED) assert.equal(isJoinStableReference(ref), false, ref);
  });

  it("refuses an unacceptable variant URI line and an unacceptable rendition URI alike", () => {
    for (const ref of REFUSED.filter((r) => r.length > 0 && !r.includes(" ") && !r.startsWith("#"))) {
      const asLine = refusal(master(MEDIA, VARIANT, ref));
      assert.ok(asLine === "invalid_uri_reference" || asLine === "control_character", `${ref}: ${asLine}`);
      if (ref.includes('"')) continue;
      const asAttribute = refusal(master(MEDIA.replace('URI="audio/main.m3u8"', `URI="${ref}"`), VARIANT, "v.m3u8"));
      // A variable reference is refused as a value before its grammar is read.
      assert.equal(asAttribute, ref.includes("{$") ? "malformed_attribute_value" : "invalid_uri_reference", ref);
    }
  });

  it("bounds a reference at 2 KiB", () => {
    const long = `${"a".repeat(2048 - "v.m3u8".length - 1)}/v.m3u8`;
    assert.equal(Buffer.byteLength(long), 2048);
    assert.doesNotThrow(() => parseClearHlsMasterPlaylist(master(MEDIA, VARIANT, long)));
    expectRefusal(master(MEDIA, VARIANT, `a${long}`), "invalid_uri_reference");
  });
});

describe("clear-HLS master parser: refusals never echo the document", () => {
  it("uses fixed messages only", () => {
    const sentinel = "LEAK_SENTINEL";
    for (const text of [
      master(`#EXT-X-${sentinel}:1`),
      master(MEDIA, VARIANT, `${sentinel}/../v.m3u8`),
      master(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${sentinel}",NAME="m",URI="a.m3u8"`, VARIANT, "v.m3u8"),
    ]) {
      try {
        parseClearHlsMasterPlaylist(text);
        assert.fail("accepted");
      } catch (err) {
        assert.ok(err instanceof ClearHlsMasterPlaylistError);
        assert.equal(err.message.includes(sentinel), false);
        assert.equal(String(err.stack).includes(sentinel), false);
      }
    }
  });
});

describe("clear-HLS master parser: the module is inert", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export function parseClearHlsMasterPlaylist"));
    assert.equal(code.includes("RFC 8216 §4.3.4.2: a variant"), false, "comments should be gone");
  });

  it("imports nothing capable of I/O", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["node:buffer"]);
  });

  it("names no network, filesystem, process, clock, logging or runtime facility", () => {
    for (const forbidden of [
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "node:child_process",
      "node:process",
      "safeGet",
      "safeHttpRequest",
      "fetch(",
      "require(",
      "import(",
      "spawn",
      "exec",
      "ffmpeg",
      "ffprobe",
      "process.env",
      "Date.now",
      "performance",
      "setTimeout",
      "Math.random",
      "console.",
    ]) {
      assert.equal(code.includes(forbidden), false, `the master parser must not reference ${forbidden}`);
    }
  });
});
