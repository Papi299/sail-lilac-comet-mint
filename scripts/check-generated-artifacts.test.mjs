import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGeneratedArtifacts,
  findForbiddenTrackedPaths,
  formatForbiddenTrackedError,
  isForbiddenTrackedPath,
} from "./check-generated-artifacts.mjs";

test("zero tracked .vercel paths pass", () => {
  const result = checkGeneratedArtifacts(["src/lib/config.ts", "README.md", "package.json"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.forbidden, []);
});

test("simulated tracked .vercel/output/config.json fails", () => {
  const result = checkGeneratedArtifacts([".vercel/output/config.json"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.forbidden, [".vercel/output/config.json"]);
  assert.match(result.message, /\.vercel/);
  assert.match(result.message, /\.vercel\/output\/config\.json/);
});

test("unrelated tracked source path passes", () => {
  assert.deepEqual(findForbiddenTrackedPaths(["src/lib/filenames.ts", "scripts/migrate.mjs"]), []);
  assert.equal(isForbiddenTrackedPath("src/lib/filenames.ts"), false);
  assert.equal(isForbiddenTrackedPath(".vercelignore"), false);
});

test("exact error clearly identifies forbidden .vercel tracking", () => {
  const paths = [".vercel/output/config.json", "src/index.ts", ".vercel/output/functions/index.mjs"];
  const result = checkGeneratedArtifacts(paths);
  assert.equal(result.ok, false);
  assert.deepEqual(result.forbidden, [
    ".vercel/output/config.json",
    ".vercel/output/functions/index.mjs",
  ]);
  const message = formatForbiddenTrackedError(result.forbidden);
  assert.match(message, /Tracked generated artifacts are forbidden/);
  assert.match(message, /\.vercel\//);
  assert.match(message, /\.vercel\/output\/config\.json/);
  assert.equal(message.includes("src/index.ts"), false);
});

test("the .vercel root itself is forbidden", () => {
  assert.equal(isForbiddenTrackedPath(".vercel"), true);
  assert.equal(isForbiddenTrackedPath("./.vercel/output/nitro.json"), true);
  assert.equal(isForbiddenTrackedPath(".vercel\\output\\config.json"), true);
});
