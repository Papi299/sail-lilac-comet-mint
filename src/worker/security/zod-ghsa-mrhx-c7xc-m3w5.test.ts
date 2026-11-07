/**
 * GHSA-mrhx-c7xc-m3w5: what the Zod floor fixes, what it does not, and what it changes.
 *
 * Every size here is small and fixed, so a regression fails an assertion and never exhausts memory.
 *
 * The fix only moves a LEADING `.max()` / `.length()` ahead of the element walk. An array with no bound
 * still builds one issue per bad element on every Zod version; for those, this application relies on its
 * byte ceilings (`YTDLP_ANALYSIS_MAX_STDOUT_BYTES` and friends).
 *
 * Reaching the patched line also brings two older upstream changes, pinned below:
 *   - string `.min()` / `.max()` / `.length()` count code points, so `.max(n)` accepts up to 2n UTF-16 units;
 *   - a `.strict()` object rejects an own `__proto__` key instead of silently dropping it.
 * Because of the first, the code that bounds upstream text BEFORE a schema sees it is what actually holds
 * those limits, and it is pinned here too.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { buildAttachmentContentDisposition, buildDownloadFilename } from "@/lib/filenames";
import { validatePublicHttpUrl } from "@/lib/validation/url";
import { SourceQualitySchema, WorkerAnalyzeRequestSchema, WorkerCreateJobRequestSchema } from "@/shared/worker/contracts";
import {
  parseAnalysisInfo,
  sanitizeUpstreamText,
  YTDLP_ANALYSIS_MAX_RAW_FORMATS,
  YTDLP_ANALYSIS_MAX_STDOUT_BYTES,
} from "@/worker/analysis/ytdlp-analysis.server";
import { acceptClearHlsPlaylistUrl } from "@/worker/hls/hls-source-selection";

const OVERSIZED = 10_000;
const ASTRAL = "\u{1F600}";
/** UTF-8 byte count equals UTF-16 unit count only when every character is ASCII. */
const isAscii = (value: string) => Buffer.byteLength(value, "utf8") === value.length;

describe("GHSA-mrhx-c7xc-m3w5 floor", () => {
  it("runs on a Zod at or above the first patched version", () => {
    const { major, minor, patch } = z.core.version;
    assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), `zod ${major}.${minor}.${patch}`);
  });

  it("rejects an oversized BOUNDED array on its bound alone, without one issue per element", () => {
    const parsed = SourceQualitySchema.safeParse({
      observedMaxHeight: null,
      deliverableMaxHeight: null,
      withheld: new Array(OVERSIZED).fill(0),
      protectedUnenumerated: false,
      maybeProtectedObserved: false,
    });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues.length, 1);
    assert.equal(parsed.error?.issues[0]?.code, "too_big");
    assert.deepEqual(parsed.error?.issues[0]?.path, ["withheld"]);
  });
});

describe("an UNBOUNDED raw-format array is held by the application's own limits", () => {
  it("keeps the stdout ceiling that bounds the document before any parse", () => {
    assert.equal(YTDLP_ANALYSIS_MAX_STDOUT_BYTES, 4 * 1024 * 1024);
  });

  it("refuses a document of junk formats as a stable rejection", () => {
    const stdout = JSON.stringify({ _type: "video", formats: new Array(OVERSIZED).fill(0) });
    assert.deepEqual(parseAnalysisInfo(stdout), { ok: false, rejection: "invalid_shape" });
  });

  it("refuses too many well-formed formats", () => {
    const formats = new Array(YTDLP_ANALYSIS_MAX_RAW_FORMATS + 1).fill({ format_id: "a" });
    assert.deepEqual(parseAnalysisInfo(JSON.stringify({ _type: "video", formats })), { ok: false, rejection: "too_many_formats" });
  });
});

describe("upstream semantics that arrive with the patched line", () => {
  it("counts string bounds in code points", () => {
    assert.equal(z.string().max(1).safeParse(ASTRAL).success, true);
    assert.equal(z.string().min(2).safeParse(ASTRAL).success, false);
  });

  it("rejects an own __proto__ key on a strict schema, and does not pollute", () => {
    const body = '{"url":"https://example.com/v","formatId":"direct-original","principalId":"private-access-user","__proto__":{"polluted":1}}';
    const parsed = WorkerCreateJobRequestSchema.safeParse(JSON.parse(body));
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues[0]?.code, "unrecognized_keys");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("still strips an own __proto__ key on the non-strict yt-dlp document", () => {
    const result = parseAnalysisInfo('{"_type":"video","__proto__":{"polluted":1}}');
    assert.equal(result.ok, true);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe("limits on upstream text hold in UTF-16 units before any schema sees it", () => {
  const hostile = ASTRAL.repeat(5000);

  it("truncates titles in units, whatever a schema's .max() counts", () => {
    assert.ok(sanitizeUpstreamText(hostile, 1024, "Video").length <= 1024);
  });

  it("derives an ASCII file name and an ASCII Content-Disposition from any title", () => {
    const filename = buildDownloadFilename({ title: `${hostile}name${hostile}`, quality: "1080p", container: "mp4" });
    assert.ok(isAscii(filename));
    assert.ok(filename.length <= 1024);
    const disposition = buildAttachmentContentDisposition(`${ASTRAL.repeat(100)}.mp4`);
    assert.ok(isAscii(disposition));
  });

  it("normalizes a submitted URL to ASCII, so the 2048 bound still counts units", () => {
    const checked = validatePublicHttpUrl(`https://example.invalid/${ASTRAL.repeat(1500)}`);
    assert.equal(checked.ok, true);
    assert.ok(checked.ok && isAscii(checked.url));
    assert.equal(checked.ok && WorkerAnalyzeRequestSchema.safeParse({ url: checked.url }).success, false);
  });

  it("applies the playlist ceiling to UTF-8 bytes, ahead of any schema", () => {
    assert.equal(acceptClearHlsPlaylistUrl(`https://example.invalid/${ASTRAL.repeat(1500)}.m3u8`), null);
  });
});
