import test from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("No yt-dlp imports in Phase 6 execution directory", () => {
  const dir = join(process.cwd(), "src/worker/execution");
  const files = readdirSync(dir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf8");
    assert.ok(!content.includes("ytdlp"), `File ${f} contains 'ytdlp'`);
    assert.ok(!content.includes("ytdlpExtractor"), `File ${f} contains 'ytdlpExtractor'`);
    assert.ok(!content.includes("downloadWithYtdlp"), `File ${f} contains 'downloadWithYtdlp'`);
    assert.ok(!content.includes("registry.server"), `File ${f} contains 'registry.server'`);
    assert.ok(!content.includes("getExtractorFor"), `File ${f} contains 'getExtractorFor'`);
  }
});
