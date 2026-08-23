import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const KNOWN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json"]);

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) {
    return nextResolve(specifier, context);
  }

  const rest = specifier.slice(2);
  const abs = join(srcRoot, rest);
  const candidates = [];
  if (KNOWN_EXT.has(extname(abs))) {
    candidates.push(abs);
  } else {
    candidates.push(abs + ".ts", abs + ".tsx", abs + ".js", join(abs, "index.ts"));
  }

  for (const file of candidates) {
    if (existsSync(file)) {
      return { shortCircuit: true, url: pathToFileURL(file).href };
    }
  }

  return {
    shortCircuit: true,
    url: pathToFileURL(candidates[0] ?? abs + ".ts").href,
  };
}
