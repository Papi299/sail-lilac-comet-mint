import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  placeClearHlsSeparateAudioPairs,
  projectClearHlsSeparateAudioPlacements,
  type ClearHlsSeparateAudioCandidate,
} from "./hls-separate-audio-selection.ts";
import { placeClearHlsShadowCandidates } from "./hls-source-selection.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: the separate-audio selection
 * vocabulary places proven pairs on the SAME ladder, by the SAME rules, as the
 * muxed clear-HLS family, and projects them down to exactly three fields.
 */

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "hls-separate-audio-selection.ts");

const RUNGS = Object.freeze([
  { minHeight: 2160, id: "preset:2160" },
  { minHeight: 1440, id: "preset:1440" },
  { minHeight: 1080, id: "preset:1080" },
  { minHeight: 720, id: "preset:720" },
  { minHeight: 480, id: "preset:480" },
  { minHeight: 360, id: "preset:360" },
  { minHeight: 240, id: "preset:240" },
  { minHeight: 144, id: "preset:144" },
]);

function pair(index: number, height: number | null): ClearHlsSeparateAudioCandidate {
  return Object.freeze({
    videoPlaylistUrl: `https://cdn.example.com/v/${index}.m3u8`,
    audioPlaylistUrl: `https://cdn.example.com/a/${index}.m3u8`,
    height,
    index,
  });
}

describe("separate-audio placement", () => {
  it("places one pair per rung and backs preset:best with the tallest", () => {
    const placed = placeClearHlsSeparateAudioPairs([pair(0, 720), pair(1, 1080), pair(2, 1080)], RUNGS);
    assert.deepEqual(Object.keys(placed).sort(), ["preset:1080", "preset:720", "preset:best"]);
    assert.equal(placed["preset:1080"]!.index, 1, "lowest upstream index wins a tie");
    assert.equal(placed["preset:best"]!.index, 1);
    assert.equal(placed["preset:720"]!.audioPlaylistUrl, "https://cdn.example.com/a/0.m3u8");
  });

  it("agrees with the muxed family's placement rung for rung", () => {
    const pairs = [pair(5, 2000), pair(1, 1081), pair(3, 700), pair(2, null), pair(4, 100)];
    const separate = placeClearHlsSeparateAudioPairs(pairs, RUNGS);
    const muxed = placeClearHlsShadowCandidates(
      pairs.map((p) => ({ playlistUrl: p.videoPlaylistUrl, height: p.height, index: p.index })),
      RUNGS,
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(separate).map(([id, c]) => [id, c.index])),
      Object.fromEntries(Object.entries(muxed).map(([id, c]) => [id, c.index])),
    );
  });

  it("falls back to one unknown-height pair for preset:best, exactly as muxed HLS does", () => {
    const placed = placeClearHlsSeparateAudioPairs([pair(7, null), pair(4, null)], RUNGS);
    assert.deepEqual(Object.keys(placed), ["preset:best"]);
    assert.equal(placed["preset:best"]!.index, 4);
  });

  it("drops every pair that shares an upstream index, fail-closed", () => {
    const placed = placeClearHlsSeparateAudioPairs([pair(1, 1080), { ...pair(1, 1080), audioPlaylistUrl: "https://x.example.com/a.m3u8" }], RUNGS);
    assert.deepEqual(placed, {});
  });

  it("freezes the placements and every placed pair", () => {
    const placed = placeClearHlsSeparateAudioPairs([pair(0, 1080)], RUNGS);
    assert.ok(Object.isFrozen(placed));
    assert.ok(Object.isFrozen(placed["preset:1080"]));
  });
});

describe("separate-audio projection", () => {
  it("projects to exactly videoPlaylistUrl, audioPlaylistUrl and height", () => {
    const selections = projectClearHlsSeparateAudioPlacements(placeClearHlsSeparateAudioPairs([pair(9, 1080)], RUNGS));
    assert.deepEqual(JSON.parse(JSON.stringify(selections)), {
      "preset:best": { videoPlaylistUrl: "https://cdn.example.com/v/9.m3u8", audioPlaylistUrl: "https://cdn.example.com/a/9.m3u8", height: 1080 },
      "preset:1080": { videoPlaylistUrl: "https://cdn.example.com/v/9.m3u8", audioPlaylistUrl: "https://cdn.example.com/a/9.m3u8", height: 1080 },
    });
    for (const selection of Object.values(selections)) {
      assert.deepEqual(Reflect.ownKeys(selection), ["videoPlaylistUrl", "audioPlaylistUrl", "height"]);
      assert.ok(Object.isFrozen(selection));
    }
    assert.ok(Object.isFrozen(selections));
  });

  it("skips any key outside the closed video vocabulary", () => {
    const forged = { "preset:audio": pair(1, 1080), "direct-original": pair(2, 1080), "preset:720": pair(3, 720) };
    assert.deepEqual(Object.keys(projectClearHlsSeparateAudioPlacements(forged)), ["preset:720"]);
  });
});

describe("separate-audio selection: the module is pure", () => {
  const code = readFileSync(MODULE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports only the muxed selection vocabulary", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["./hls-source-selection.ts"]);
  });

  it("names no I/O, clock or master facility", () => {
    for (const forbidden of ["node:", "safeGet", "fetch(", "Date.now", "performance", "manifest", "master", "group"]) {
      assert.equal(code.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });
});
