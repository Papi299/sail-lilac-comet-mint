#!/usr/bin/env node
/**
 * Fail if Git-tracked files exist under generated-output roots that must not
 * be version-controlled. Deployment artifacts must be produced from the
 * reviewed source commit, never committed as authoritative repository content.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const FORBIDDEN_GENERATED_ROOTS = Object.freeze([".vercel"]);

export function isForbiddenTrackedPath(path, roots = FORBIDDEN_GENERATED_ROOTS) {
  const normalized = String(path ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (!normalized) return false;
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function findForbiddenTrackedPaths(trackedPaths, roots = FORBIDDEN_GENERATED_ROOTS) {
  return trackedPaths.filter((path) => isForbiddenTrackedPath(path, roots));
}

export function formatForbiddenTrackedError(paths) {
  const listed = paths.map((path) => `  ${path}`).join("\n");
  return [
    "Tracked generated artifacts are forbidden.",
    "Git must not contain files under:",
    ...FORBIDDEN_GENERATED_ROOTS.map((root) => `  ${root}/`),
    "Found:",
    listed,
    "Remove these paths from Git and keep .vercel/ ignored.",
  ].join("\n");
}

export function listGitTrackedFiles(cwd = process.cwd(), gitArgs = ["ls-files", "-z"]) {
  const result = spawnSync("git", gitArgs, {
    cwd,
    encoding: "buffer",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8").trim() || "git ls-files failed";
    throw new Error(stderr);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean);
}

export function checkGeneratedArtifacts(trackedPaths) {
  const forbidden = findForbiddenTrackedPaths(trackedPaths);
  if (forbidden.length === 0) {
    return { ok: true, forbidden, message: "no tracked generated artifacts" };
  }
  return { ok: false, forbidden, message: formatForbiddenTrackedError(forbidden) };
}

function main() {
  const tracked = listGitTrackedFiles();
  const result = checkGeneratedArtifacts(tracked);
  if (result.ok) {
    console.log("[check:artifacts] no tracked generated artifacts");
    process.exit(0);
  }
  console.error(result.message);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
