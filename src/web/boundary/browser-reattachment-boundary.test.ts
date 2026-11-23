import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: what the
 * downloader PAGE ships to the browser. Its value-import graph — the page, the
 * access gate, and everything they reach — must contain no server-only module,
 * no Node built-in, and no secret; and the tab's job memory is written by one
 * module only, under one versioned key, holding only an id.
 *
 * `import type` is erased from the bundle, so it is not followed.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(ROOT, "src");
const ENTRIES = ["src/routes/index.tsx", "src/components/video/private-access-gate.tsx"];

function valueSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statement = /^\s*(?:import|export)\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(statement)) specs.push(match[2]);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(match[1]);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(match[1]);
  return specs;
}

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function browserGraph(): Map<string, string> {
  const graph = new Map<string, string>();
  const queue = ENTRIES.map((e) => join(ROOT, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = readFileSync(file, "utf8");
    graph.set(file, source);
    for (const spec of valueSpecifiers(source)) {
      if (spec.startsWith("node:")) {
        graph.set(`${file}::${spec}`, "");
        continue;
      }
      const resolved = resolveSpecifier(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return graph;
}

const rel = (file: string) => relative(ROOT, file);
const graph = browserGraph();
const files = [...graph.keys()].filter((key) => !key.includes("::"));

const LD4B_BROWSER_MODULES = [
  "src/lib/active-job-storage.ts",
  "src/lib/job-activity-ui.ts",
  "src/lib/downloader-state.ts",
  "src/components/video/progress-card.tsx",
  "src/components/video/restoring-card.tsx",
  "src/components/video/job-summary.tsx",
];

const SECRET_NAMES = [
  "VIDEOFETCH_ACCESS_SECRET",
  "WORKER_CONTROL_SECRET",
  "WORKER_CONTROL_KEY_ID",
  "WORKER_BASE_URL",
  "R2_SIGNER_ACCESS_KEY_ID",
  "R2_SIGNER_SECRET_ACCESS_KEY",
  "R2_SIGNER_SESSION_TOKEN",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
];

describe("the downloader page's browser bundle", () => {
  it("is a real graph that reaches every LD-4b browser module", () => {
    assert.ok(files.length >= 20, `a real graph: ${files.length} modules`);
    for (const module of LD4B_BROWSER_MODULES) {
      assert.ok(graph.has(join(ROOT, module)), `${module} is reached from the page`);
    }
  });

  it("imports no server-only module and no Node built-in", () => {
    for (const key of graph.keys()) {
      assert.equal(key.includes("::node:"), false, `${rel(key.split("::")[0])} imports ${key.split("::")[1]}`);
      assert.equal(/\.server\.(ts|tsx)$/.test(key), false, `${rel(key)} is server-only`);
    }
  });

  it("the LD-4b browser modules read no environment and name no secret", () => {
    for (const module of LD4B_BROWSER_MODULES) {
      const source = graph.get(join(ROOT, module))!;
      assert.equal(source.includes("process.env"), false, `${module} reads the environment`);
      assert.equal(source.includes("import.meta.env"), false, `${module} reads the build environment`);
      for (const name of SECRET_NAMES) assert.equal(source.includes(name), false, `${module} names ${name}`);
    }
  });
});

describe("the tab's job memory", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it("session storage is touched by the job memory and two pre-existing modules only", () => {
    // `client-api.ts` keeps the recent-URL list (pre-existing); `auth/client.ts`
    // is the unused accounts template's bearer token (pre-existing, not on the
    // downloader page). Neither is changed by LD-4b.
    const users = sources(SRC)
      .filter((file) => /sessionStorage/.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();
    assert.deepEqual(users, ["src/lib/active-job-storage.ts", "src/lib/auth/client.ts", "src/lib/client-api.ts"]);
    assert.equal(graph.has(join(SRC, "lib/auth/client.ts")), false, "the template's token store is not on the page");
  });

  it("the storage module writes one versioned key, with the id and the version only", () => {
    const source = readFileSync(join(SRC, "lib/active-job-storage.ts"), "utf8");
    assert.match(source, /ACTIVE_JOB_STORAGE_KEY = "videofetch:active-job:v1"/);
    const writes = [...source.matchAll(/storage\.setItem\(([^;]+)\);/g)].map((m) => m[1].replace(/\s+/g, " "));
    assert.deepEqual(writes, ["ACTIVE_JOB_STORAGE_KEY, JSON.stringify({ v: ACTIVE_JOB_STORAGE_VERSION, jobId })"]);
    assert.equal(/localStorage/.test(source), false, "never local storage: it outlives the tab and the session");
  });
});
