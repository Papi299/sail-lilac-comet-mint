// DASH-01's command line: exactly the identity the SPLIT-07 parent observed.
//
// Pure and import-free apart from the harness's own import-free modules, so
// the script tests pin it without the product's TypeScript.

import { basename } from "node:path";
import { isFullGitSha } from "./split-provenance.mjs";

/**
 * Every flag is required and may appear once. The source identity must be full
 * 40-hex SHAs, the context must be asserted clean, and the evidence path must
 * be absolute with a plain file name.
 */
export function parseDashArgv(argv) {
  const out = {
    evidence: null, sourceCommit: null, sourceTree: null, sourceContextClean: false,
    candidateTag: null, candidateImageId: null, runImageId: null,
  };
  const valueFlags = {
    "--evidence": "evidence",
    "--source-commit": "sourceCommit",
    "--source-tree": "sourceTree",
    "--candidate-tag": "candidateTag",
    "--candidate-image-id": "candidateImageId",
    "--run-image-id": "runImageId",
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`${arg} given twice`);
    seen.add(arg);
    if (arg === "--source-context-clean") {
      out.sourceContextClean = true;
      continue;
    }
    if (!Object.hasOwn(valueFlags, arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    out[valueFlags[arg]] = value;
    i += 1;
  }
  for (const [flag, key] of Object.entries(valueFlags)) {
    if (!out[key]) throw new Error(`${flag} is required`);
  }
  if (!out.sourceContextClean) throw new Error("--source-context-clean is required");
  if (!isFullGitSha(out.sourceCommit) || !isFullGitSha(out.sourceTree)) {
    throw new Error("--source-commit and --source-tree must be full 40-hex SHAs");
  }
  if (!out.evidence.startsWith("/") || !/^[A-Za-z0-9._-]+$/.test(basename(out.evidence))) {
    throw new Error("--evidence must be an absolute path with a plain file name");
  }
  return out;
}
