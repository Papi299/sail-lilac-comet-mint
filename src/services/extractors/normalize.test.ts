import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPresets,
  normalizeYtdlpFormat,
  parseYtdlpProgress,
  resolutionFromHeight,
  scoreFormat,
  ytDlpFormatSelector,
} from "./normalize.ts";

describe("format normalization", () => {
  it("maps heights to resolution labels", () => {
    assert.equal(resolutionFromHeight(2160), "2160p");
    assert.equal(resolutionFromHeight(1080), "1080p");
    assert.equal(resolutionFromHeight(720), "720p");
    assert.equal(resolutionFromHeight(480), "480p");
  });

  it("drops storyboards and empty codecs", () => {
    assert.equal(
      normalizeYtdlpFormat({ format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" }),
      null,
    );
  });

  it("normalizes a combined mp4 stream", () => {
    const format = normalizeYtdlpFormat({
      format_id: "22",
      ext: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      vcodec: "avc1.64001F",
      acodec: "mp4a.40.2",
      filesize: 12_000_000,
      tbr: 2500,
    });
    assert.ok(format);
    assert.equal(format?.resolution, "720p");
    assert.equal(format?.videoCodec, "h264");
    assert.equal(format?.audioCodec, "aac");
    assert.equal(format?.hasVideo, true);
    assert.equal(format?.hasAudio, true);
  });

  it("does not advertise missing qualities", () => {
    const formats = [
      normalizeYtdlpFormat({
        format_id: "18",
        ext: "mp4",
        width: 640,
        height: 360,
        vcodec: "avc1",
        acodec: "mp4a",
        filesize: 4_000_000,
      })!,
    ];
    const presets = buildPresets(formats, { mp3: true });
    const ids = presets.map((p) => p.id);
    assert.ok(ids.includes("preset:best"));
    assert.ok(ids.includes("preset:360"));
    assert.equal(ids.includes("preset:1080"), false);
    assert.equal(ids.includes("preset:2160"), false);
  });

  it("prefers combined h264 mp4 when scoring", () => {
    const a = normalizeYtdlpFormat({
      format_id: "22",
      ext: "mp4",
      height: 720,
      vcodec: "avc1",
      acodec: "mp4a",
    })!;
    const b = normalizeYtdlpFormat({
      format_id: "248",
      ext: "webm",
      height: 720,
      vcodec: "vp9",
      acodec: "none",
    })!;
    assert.ok(scoreFormat(a) > scoreFormat(b));
  });
});

describe("yt-dlp progress parsing", () => {
  it("parses a real progress line", () => {
    const parsed = parseYtdlpProgress(
      "[download]  64.0% of  128.00MiB at    8.20MiB/s ETA 00:06",
    );
    assert.ok(parsed);
    assert.equal(parsed?.progress, 64);
    assert.ok((parsed?.totalBytes ?? 0) > 100_000_000);
    assert.ok((parsed?.speed ?? 0) > 1_000_000);
    assert.equal(parsed?.eta, 6);
  });

  it("returns null for unrelated lines", () => {
    assert.equal(parseYtdlpProgress("[info] downloading"), null);
  });
});

describe("format selector", () => {
  it("maps presets to yt-dlp selectors", () => {
    assert.equal(ytDlpFormatSelector("preset:best").selector, "bv*+ba/b");
    assert.equal(ytDlpFormatSelector("preset:1080").heightCap, 1080);
    assert.equal(ytDlpFormatSelector("preset:mp3").audioFormat, "mp3");
    assert.equal(ytDlpFormatSelector("22").selector, "22");
  });
});
