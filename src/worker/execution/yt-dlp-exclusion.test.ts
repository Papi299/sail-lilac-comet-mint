import test from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isYtdlpNetworkIsolated } from "@/lib/config";

/** Every Phase-6 production module, scanned dynamically so new files are covered. */
const PHASE_6_PRODUCTION_DIRS = ["src/worker/execution", "src/worker/state"];

function productionFiles(dir: string): string[] {
  const abs = join(process.cwd(), dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(abs, f));
}

/**
 * Tokens that name the LEGACY Vercel-era extractor stack. These are forbidden
 * everywhere in the scanned surface, in every phase, without exception (§50).
 *
 * The legacy modules still exist as historical application code, but the
 * Production Worker must never reach them: `downloadWithYtdlp` runs FFmpeg
 * inside its download path, which would perform local media work while a
 * durable job still says `downloading`, and `mapExtractorMessage` builds errors
 * out of raw upstream text.
 */
const FORBIDDEN_LEGACY_TOKENS = [
  "ytdlpExtractor",
  "downloadWithYtdlp",
  "normalizeYtdlpFormat",
  "ytDlpFormatSelector",
  "mapExtractorMessage",
  "registry.server",
  "getExtractorFor",
  "sampleExtractor",
];

/**
 * Tokens naming the yt-dlp runtime at all.
 *
 * Phase 10C3 introduces a REVIEWED generic execution path, so these are no
 * longer forbidden outright across `src/worker/execution` — but they remain
 * forbidden in every file except the explicit allowlist below, and forbidden
 * everywhere in `src/worker/state`.
 *
 * Durable state stays strategy-agnostic apart from the closed
 * `WorkerExtractorStrategySchema` enum: it records WHICH strategy an execution
 * selected, never how to run one.
 */
const YTDLP_RUNTIME_TOKENS = ["ytdlp", "yt-dlp", "yt_dlp"];

/**
 * The ONLY execution-surface files permitted to name the yt-dlp runtime.
 *
 * An allowlist rather than a pattern: a new module gaining generic coupling
 * should be a deliberate, reviewed edit to this list, not an accident of
 * filename.
 */
const GENERIC_EXECUTION_ALLOWLIST = new Set([
  "generic-source.ts",
  "ytdlp-download.server.ts",
  "format-plan.ts",
  "job-executor.server.ts",
]);

test("No LEGACY extractor coupling anywhere in the Phase-6 production surface", () => {
  let scanned = 0;
  for (const dir of PHASE_6_PRODUCTION_DIRS) {
    for (const file of productionFiles(dir)) {
      scanned += 1;
      const content = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_LEGACY_TOKENS) {
        assert.ok(
          !content.includes(token),
          `${file} references forbidden legacy token '${token}'`,
        );
      }
    }
  }
  assert.ok(scanned >= 6, `expected to scan the Phase-6 production surface, saw ${scanned} files`);
});

test("Durable state remains free of yt-dlp runtime coupling", () => {
  for (const file of productionFiles("src/worker/state")) {
    const content = readFileSync(file, "utf8");
    for (const token of YTDLP_RUNTIME_TOKENS) {
      assert.ok(
        !content.includes(token),
        `${file} couples durable state to the yt-dlp runtime via '${token}'`,
      );
    }
  }
});

test("Only the reviewed generic-execution modules name the yt-dlp runtime", () => {
  for (const file of productionFiles("src/worker/execution")) {
    const name = file.split("/").pop()!;
    if (GENERIC_EXECUTION_ALLOWLIST.has(name)) continue;
    const content = readFileSync(file, "utf8");
    for (const token of YTDLP_RUNTIME_TOKENS) {
      assert.ok(
        !content.includes(token),
        `${file} is not on the generic-execution allowlist but references '${token}'`,
      );
    }
  }
});

test("Phase-6 execution modules import only the direct-media path", () => {
  const executionFiles = productionFiles("src/worker/execution");
  const seen = executionFiles.map((f) => f.split("/").pop());

  // The execution surface must include the plan and the direct-media analyzer.
  assert.ok(seen.includes("format-plan.ts"), "the explicit execution plan module must exist");
  assert.ok(seen.includes("direct-media.server.ts"));

  for (const file of executionFiles) {
    const content = readFileSync(file, "utf8");
    const importLines = content
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+"/.test(line));
    for (const line of importLines) {
      assert.ok(
        !/extractors\/(registry|ytdlp|sample)/.test(line),
        `${file} imports a non-direct extractor: ${line.trim()}`,
      );
    }
  }
});

test("Phase-6 spawns nothing directly; all subprocesses go through runProcess", () => {
  for (const dir of PHASE_6_PRODUCTION_DIRS) {
    for (const file of productionFiles(dir)) {
      const content = readFileSync(file, "utf8");
      assert.ok(!content.includes("node:child_process"), `${file} imports child_process`);
      assert.ok(!/\bspawn\s*\(/.test(content), `${file} spawns a subprocess directly`);
      assert.ok(!/\bexecFile\s*\(/.test(content), `${file} calls execFile directly`);
    }
  }
});

test("YTDLP_NETWORK_ISOLATED remains fail-closed and is not enabled by Phase-6", () => {
  const previous = process.env.YTDLP_NETWORK_ISOLATED;
  try {
    delete process.env.YTDLP_NETWORK_ISOLATED;
    assert.strictEqual(
      isYtdlpNetworkIsolated(),
      false,
      "the isolation attestation must default to fail-closed",
    );
  } finally {
    if (previous === undefined) delete process.env.YTDLP_NETWORK_ISOLATED;
    else process.env.YTDLP_NETWORK_ISOLATED = previous;
  }

  // Nothing in the Phase-6 surface may set or attest the flag.
  for (const dir of PHASE_6_PRODUCTION_DIRS) {
    for (const file of productionFiles(dir)) {
      const content = readFileSync(file, "utf8");
      assert.ok(
        !content.includes("YTDLP_NETWORK_ISOLATED"),
        `${file} touches the yt-dlp isolation attestation`,
      );
      assert.ok(
        !content.includes("isYtdlpNetworkIsolated"),
        `${file} reads the yt-dlp isolation attestation`,
      );
    }
  }
});
