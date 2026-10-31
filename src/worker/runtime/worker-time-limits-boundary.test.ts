import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001 — the Worker time-limit boundary.
 *
 * The Worker's acquisition and processing limits have ONE owner: the strict
 * loader (`DOWNLOAD_TIME_LIMIT`, `PROCESSING_TIMEOUT`), built once into
 * `WorkerTimeLimits` and injected. This test walks the Worker's REAL production
 * import graph from its executable entry and fails if any reachable module
 *
 *   - reads the legacy module budget (`config.downloadTimeoutMs`, in any
 *     spelling: property or element access, destructuring, an alias),
 *   - names the retired `DOWNLOAD_TIMEOUT` (an environment read by literal or
 *     property name),
 *   - uses the retired `downloadTimeoutSeconds` field, or
 *   - names `DOWNLOAD_TIME_LIMIT` / `PROCESSING_TIMEOUT` outside the strict
 *     loader, i.e. reads a new limit from the environment downstream,
 *
 * except where an explicit, reasoned classification below allows it. It reads
 * the source through the TypeScript parser, so a comment or a string in prose is
 * never a finding, and it is function-aware: a legacy read is allowed only in
 * the named legacy function, never in the module that merely contains it.
 *
 * Every positive control runs the same checker over an in-memory OVERLAY of the
 * real graph. Nothing is ever written to the repository.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const WORKER_ENTRY = "src/worker/runtime/main.server.ts";

const IMPORT_RE =
  /(?:^|[\s;{(])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

/** Repo-relative path → source. Overlays replace or add files in memory only. */
type Overlay = Readonly<Record<string, string>>;

function makeReader(overlay: Overlay) {
  const abs = (rel: string) => join(ROOT, rel);
  const overlaid = new Map(Object.entries(overlay).map(([rel, source]) => [abs(rel), source]));
  return {
    exists: (file: string) => overlaid.has(file) || (existsSync(file) && statSync(file).isFile()),
    read: (file: string) => overlaid.get(file) ?? readFileSync(file, "utf8"),
  };
}

function resolveSpecifier(fromFile: string, spec: string, exists: (file: string) => boolean): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromFile), spec);
  else return null; // a package or a node: builtin
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The transitive production module graph reachable from the Worker entry. */
function workerGraph(overlay: Overlay = {}): Map<string, string> {
  const { exists, read } = makeReader(overlay);
  const graph = new Map<string, string>();
  const queue = [join(ROOT, WORKER_ENTRY)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file) || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const source = read(file);
    graph.set(file, source);
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      const resolved = resolveSpecifier(file, spec, exists);
      if (resolved) queue.push(resolved);
    }
  }
  return graph;
}

const rel = (file: string) => relative(ROOT, file).split("\\").join("/");

// ── The AST scan ─────────────────────────────────────────────────────────────

type FindingKind =
  /** `x.downloadTimeoutMs`, `x["downloadTimeoutMs"]`, `{ downloadTimeoutMs } = x` */
  | "legacy-budget-read"
  /** `downloadTimeoutMs: …` in an object literal: where the legacy loader defines it */
  | "legacy-budget-definition"
  /** `"DOWNLOAD_TIMEOUT"` or `.DOWNLOAD_TIMEOUT` */
  | "retired-variable"
  /** the identifier `downloadTimeoutSeconds` */
  | "retired-field"
  /** `"DOWNLOAD_TIME_LIMIT"` / `"PROCESSING_TIMEOUT"` or the same as a property name */
  | "stage-variable";

/** `owners`: the named declarations enclosing the finding, innermost first. */
type Finding = { file: string; kind: FindingKind; owners: readonly string[]; line: number };

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** Every NAMED declaration enclosing a node — functions, methods, variables, members — innermost first. */
function ownersOf(node: ts.Node): string[] {
  const owners: string[] = [];
  for (let at: ts.Node | undefined = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) owners.push(at.name.getText());
    else if (ts.isConstructorDeclaration(at)) owners.push("constructor");
    else if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) owners.push(at.name.text);
    else if ((ts.isPropertyDeclaration(at) || ts.isGetAccessorDeclaration(at)) && at.name) owners.push(at.name.getText());
  }
  return owners;
}

// LD-2a adds UPLOAD_TIMEOUT: parsed by the strict loader alone, like the LD-1 pair.
const STAGE_VARIABLES = new Set(["DOWNLOAD_TIME_LIMIT", "PROCESSING_TIMEOUT", "UPLOAD_TIMEOUT"]);

function scan(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const add = (node: ts.Node, kind: FindingKind) =>
    findings.push({
      file: rel(file),
      kind,
      owners: ownersOf(node),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "downloadTimeoutMs") add(node, "legacy-budget-read");
      if (name === "DOWNLOAD_TIMEOUT") add(node, "retired-variable");
      if (STAGE_VARIABLES.has(name)) add(node, "stage-variable");
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      if (node.argumentExpression.text === "downloadTimeoutMs") add(node, "legacy-budget-read");
    } else if (ts.isBindingElement(node)) {
      const bound = propertyNameText(node.propertyName) ?? propertyNameText(node.name);
      if (bound === "downloadTimeoutMs") add(node, "legacy-budget-read");
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      if (propertyNameText(node.name) === "downloadTimeoutMs") add(node, "legacy-budget-definition");
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === "DOWNLOAD_TIMEOUT") add(node, "retired-variable");
      if (STAGE_VARIABLES.has(node.text)) add(node, "stage-variable");
    } else if (ts.isIdentifier(node) && node.text === "downloadTimeoutSeconds") {
      add(node, "retired-field");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

// ── The classification ───────────────────────────────────────────────────────

/**
 * Every finding the boundary ALLOWS, with its reason. Anything else anywhere in
 * the Worker graph is an unexpected dependency and fails the test.
 */
const CLASSIFIED: ReadonlyArray<{
  readonly file: string;
  readonly category: string;
  readonly allows: (f: Finding) => boolean;
}> = [
  {
    // The legacy module loader stays Worker-reachable for MAX_FILE_SIZE,
    // MAX_REDIRECTS, ANALYSIS_TIMEOUT and FFMPEG_PATH (held equal to the strict
    // loader by `config-loader-agreement.test.ts`). It still DEFINES the legacy
    // budget for the legacy in-process modules; defining it is not reading it.
    file: "src/lib/config.ts",
    category: "intentionally retained legacy loader",
    allows: (f) =>
      f.owners.join(">") === "config" &&
      (f.kind === "legacy-budget-definition" || f.kind === "retired-variable"),
  },
  {
    // The strict loader is the ONE owner: it reads the two stage variables and
    // names the retired one only to refuse it.
    file: "src/worker/runtime/config.server.ts",
    category: "strict owner (reads the stage limits; refuses the retired variable)",
    allows: (f) =>
      (f.kind === "retired-variable" && f.owners.join(">") === "WORKER_FORBIDDEN_TIME_LIMIT_VARIABLES") ||
      (f.kind === "stage-variable" && f.owners.at(-1) === "loadWorkerRuntimeConfig"),
  },
  {
    // `direct.server.ts` also holds the legacy APPLICATION path. Its reads are
    // allowed only inside that function, never in the Worker entry beside it.
    file: "src/services/extractors/direct.server.ts",
    category: "intentionally retained legacy function (downloadDirect)",
    allows: (f) => f.kind === "legacy-budget-read" && f.owners.join(">") === "downloadDirect",
  },
];

function violations(graph: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, source] of graph) {
    for (const finding of scan(file, source)) {
      const entry = CLASSIFIED.find((c) => c.file === finding.file);
      if (!entry || !entry.allows(finding)) out.push(finding);
    }
  }
  return out;
}

const describeFinding = (f: Finding) =>
  `${f.file}:${f.line} ${f.kind} in ${f.owners.length > 0 ? f.owners.join(" < ") : "<module>"}`;

// ─────────────────────────────────────────────────────────────────────────────

describe("Worker time-limit boundary (VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001)", () => {
  const graph = workerGraph();
  const files = new Set([...graph.keys()].map(rel));

  it("walks the Worker's REAL production graph from its executable entry", () => {
    assert.ok(graph.size >= 50, `expected a real graph, saw ${graph.size} modules`);
    for (const expected of [
      WORKER_ENTRY,
      "src/worker/runtime/runtime.server.ts",
      "src/worker/runtime/config.server.ts",
      "src/worker/runtime/time-limits.ts",
      "src/worker/execution/job-executor.server.ts",
      "src/worker/execution/ytdlp-download.server.ts",
      "src/services/extractors/direct.server.ts",
      "src/worker/hls/hls-execution.server.ts",
      "src/worker/hls/hls-fragment-acquisition.server.ts",
      "src/worker/hls/hls-separate-audio-execution.server.ts",
      "src/services/processing/ffmpeg.server.ts",
      "src/lib/config.ts",
    ]) {
      assert.ok(files.has(expected), `${expected} must be reachable from the Worker entry`);
    }
  });

  it("finds NO unclassified legacy-budget, retired-variable or downstream stage-variable dependency", () => {
    const found = violations(graph);
    assert.deepEqual(found.map(describeFinding), []);
  });

  it("positive controls: the scan really sees each classified use", () => {
    const of = (file: string) => scan(join(ROOT, file), graph.get(join(ROOT, file))!);
    const lax = of("src/lib/config.ts");
    assert.deepEqual(
      lax.map((f) => f.kind).sort(),
      ["legacy-budget-definition", "retired-variable"],
      "exactly the legacy definition and its one variable read",
    );
    const strict = of("src/worker/runtime/config.server.ts");
    assert.equal(strict.filter((f) => f.kind === "retired-variable").length, 1);
    assert.deepEqual(
      strict.filter((f) => f.kind === "stage-variable").length,
      6,
      "DOWNLOAD_TIME_LIMIT, PROCESSING_TIMEOUT and UPLOAD_TIMEOUT, each as a name and an env read",
    );
    const direct = of("src/services/extractors/direct.server.ts");
    assert.ok(direct.length >= 1, "the legacy application path's reads are seen");
    assert.ok(direct.every((f) => f.owners.join(">") === "downloadDirect"));
  });

  it("keeps the legacy application path unreachable from every OTHER Worker module", () => {
    // The only route to `downloadDirect` is `directExtractor`; no Worker module
    // outside its own file names either, and the legacy registry is not reached.
    assert.equal(files.has("src/services/extractors/registry.server.ts"), false);
    for (const [file, source] of graph) {
      if (rel(file) === "src/services/extractors/direct.server.ts") continue;
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      const names: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && (node.text === "directExtractor" || node.text === "downloadDirect")) {
          names.push(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      assert.deepEqual(names, [], `${rel(file)} must not reach the legacy direct path`);
    }
  });

  it("declares NO environment read in any downstream module: only the loaders and the entry touch process.env", () => {
    const allowed = new Set([
      "src/worker/runtime/config.server.ts",
      "src/worker/runtime/main.server.ts",
      "src/lib/config.ts",
      // Hands a subprocess the caller's environment or the inherited one; it
      // reads no variable by name.
      "src/services/processing/process-runner.server.ts",
    ]);
    for (const [file, source] of graph) {
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      let reads = 0;
      const visit = (node: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === "env" &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "process"
        ) {
          reads += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      if (!allowed.has(rel(file))) assert.equal(reads, 0, `${rel(file)} reads process.env`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Positive mutation controls: a planted dependency, in memory, must fail it
// ─────────────────────────────────────────────────────────────────────────────

describe("Worker time-limit boundary: planted dependencies are caught (in-memory overlay)", () => {
  const real = (file: string) => readFileSync(join(ROOT, file), "utf8");
  const plant = (file: string, code: string): Overlay => ({ [file]: `${real(file)}\n${code}\n` });
  const flagged = (overlay: Overlay) => violations(workerGraph(overlay)).map(describeFinding);

  it("the unmodified graph is clean (the baseline every control is measured against)", () => {
    assert.deepEqual(flagged({}), []);
  });

  for (const [label, file, code, expected] of [
    [
      "a property read in the executor",
      "src/worker/execution/job-executor.server.ts",
      "export const ld1PlantedA = config.downloadTimeoutMs;",
      "src/worker/execution/job-executor.server.ts",
    ],
    [
      "an element read through an alias, in the merge module",
      "src/services/processing/ffmpeg.server.ts",
      'import { config as ld1PlantedAlias } from "@/lib/config";\nexport const ld1PlantedB = ld1PlantedAlias["downloadTimeoutMs"];',
      "src/services/processing/ffmpeg.server.ts",
    ],
    [
      "a destructuring read in the HLS transport",
      "src/worker/hls/hls-fragment-acquisition.server.ts",
      "export function ld1PlantedC() { const { downloadTimeoutMs } = config; return downloadTimeoutMs; }",
      "src/worker/hls/hls-fragment-acquisition.server.ts",
    ],
    [
      "a direct environment read of the retired variable",
      "src/worker/hls/hls-separate-audio-execution.server.ts",
      "export const ld1PlantedD = process.env.DOWNLOAD_TIMEOUT;",
      "src/worker/hls/hls-separate-audio-execution.server.ts",
    ],
    [
      "a downstream read of a NEW stage variable",
      "src/worker/execution/ytdlp-download.server.ts",
      'export const ld1PlantedE = Number(process.env["DOWNLOAD_TIME_LIMIT"]);',
      "src/worker/execution/ytdlp-download.server.ts",
    ],
    [
      "a downstream read of UPLOAD_TIMEOUT (LD-2a)",
      "src/worker/storage/upload-lifecycle.server.ts",
      "export const ld1PlantedH = process.env.UPLOAD_TIMEOUT;",
      "src/worker/storage/upload-lifecycle.server.ts",
    ],
    [
      "the retired field reintroduced in the runtime",
      "src/worker/runtime/runtime.server.ts",
      "export const ld1PlantedF = { downloadTimeoutSeconds: 600 };",
      "src/worker/runtime/runtime.server.ts",
    ],
    [
      "a legacy read inside the direct WORKER entry's module, outside the legacy function",
      "src/services/extractors/direct.server.ts",
      "export function ld1PlantedG() { return config.downloadTimeoutMs; }",
      "src/services/extractors/direct.server.ts",
    ],
  ] as const) {
    it(`catches ${label}`, () => {
      const found = flagged(plant(file, code));
      assert.ok(found.length >= 1, `${label}: nothing flagged`);
      assert.ok(found.every((f) => f.startsWith(`${expected}:`)), found.join("; "));
    });
  }

  it("catches a forbidden read in a NEW module reached only transitively", () => {
    const planted = "src/worker/execution/planted-leak.server.ts";
    const host = "src/worker/execution/ytdlp-download.server.ts";
    const overlay: Overlay = {
      [planted]: 'import { config } from "@/lib/config";\nexport const leaked = config.downloadTimeoutMs;\n',
      [host]: `import { leaked as ld1PlantedLeak } from "./planted-leak.server.ts";\nvoid ld1PlantedLeak;\n${real(host)}`,
    };
    const graph = workerGraph(overlay);
    assert.ok(graph.has(join(ROOT, planted)), "the walker follows the planted import");
    assert.deepEqual(
      violations(graph).map((f) => f.file),
      [planted],
    );
  });

  it("does NOT flag prose: comments and identifiers that merely contain the names", () => {
    const overlay = plant(
      "src/worker/execution/job-executor.server.ts",
      [
        "// config.downloadTimeoutMs and DOWNLOAD_TIMEOUT are retired (a comment)",
        "/* process.env.DOWNLOAD_TIMEOUT, downloadTimeoutSeconds */",
        "export const downloadTimeoutMsDescription = 1;",
      ].join("\n"),
    );
    assert.deepEqual(flagged(overlay), []);
  });

  it("never wrote anything: the real sources are byte-identical after every control", () => {
    for (const file of [
      "src/worker/execution/job-executor.server.ts",
      "src/services/processing/ffmpeg.server.ts",
      "src/worker/execution/ytdlp-download.server.ts",
      "src/worker/storage/upload-lifecycle.server.ts",
    ]) {
      assert.equal(real(file).includes("ld1Planted"), false, file);
    }
    assert.equal(existsSync(join(ROOT, "src/worker/execution/planted-leak.server.ts")), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The model is consumed consistently: every acquisition seam gets the SAME
// acquisition limit and every processing seam the SAME processing budget
// ─────────────────────────────────────────────────────────────────────────────

describe("WorkerTimeLimits is consumed consistently by every stage seam", () => {
  const file = join(ROOT, "src/worker/execution/job-executor.server.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const squash = (text: string) => text.replace(/\s+/g, " ");

  /** Every `this.<seam>(…)` call, with its last argument's text. */
  function seamCalls(seam: string): string[] {
    const out: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.expression.name.text === seam
      ) {
        out.push(squash(node.arguments.at(-1)!.getText(sf)));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  for (const seam of ["downloadOriginal", "acquireClearHls", "acquireSeparateHls"]) {
    it(`${seam} receives the acquisition limit and nothing of processing's`, () => {
      const calls = seamCalls(seam);
      assert.equal(calls.length, 1, `${seam} is called exactly once`);
      assert.match(calls[0]!, /\bdownloadTimeLimitMs\b/);
      assert.doesNotMatch(calls[0]!, /processingMs/);
    });
  }

  for (const seam of ["downloadGeneric", "downloadGenericSplit"]) {
    it(`${seam} receives the combined byte and acquisition limits`, () => {
      const calls = seamCalls(seam);
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /limits: this\.genericDownloadLimits\b/);
    });
  }

  for (const seam of ["processLocally", "mergeSplit", "processClearHls", "processSeparateHls"]) {
    it(`${seam} receives the processing budget and never the acquisition limit`, () => {
      const calls = seamCalls(seam);
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /timeoutMs: this\.stageTimeLimits\.processingMs\b/);
      assert.doesNotMatch(calls[0]!, /downloadTimeLimitMs/);
    });
  }

  it("derives every acquisition value from the ONE model", () => {
    const text = squash(sf.getText());
    assert.match(text, /const downloadTimeLimitMs = this\.stageTimeLimits\.downloadTimeLimitMs;/);
    assert.match(text, /downloadTimeLimitMs: this\.stageTimeLimits\.downloadTimeLimitMs, \}\);/);
    // The production HLS seams forward exactly what the executor handed them.
    assert.equal(text.split("downloadTimeLimitMs: ctx.downloadTimeLimitMs,").length - 1, 2);
  });

  it("the runtime builds the model exactly once and hands it over AFTER the test seams", () => {
    const runtime = squash(readFileSync(join(ROOT, "src/worker/runtime/runtime.server.ts"), "utf8"));
    assert.equal(runtime.split("buildWorkerTimeLimits(").length - 1, 1);
    assert.match(runtime, /\.\.\.executorDeps, \/\/ [^\n]*?timeLimits, \}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001: ONE derivation of the job
// lifetime, and UPLOAD_TIMEOUT parsed and budgeted but NOT enforced
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where each LD-2a name may appear in the Worker's production graph — as a
 * property read, a property written in an object literal, a destructured
 * binding, an identifier or a string literal. Anywhere else is a finding.
 *
 *  - `uploadMs`: the model, which defines it and sums it into `L`, and — since
 *    VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001 deliberately updated this
 *    table — the executor, which turns it into the upload stage's ONE absolute
 *    deadline. The upload lifecycle and the storage layer never read it: they
 *    receive that deadline, never a duration they could restart.
 *  - `executionLifetimeMs` / `retentionMs`: the model (definition), the
 *    composition root (hands them to the store) and the store (assigns them).
 *    Never the executor, the HTTP view or the storage layer: the executor
 *    reads its deadline back from the claimed job.
 *  - `EXECUTION_MARGIN_SECONDS`: only the model — `L` is computed once.
 *  - `jobTtlMs`: only the store, which refuses it by presence.
 */
const LD2A_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  uploadMs: ["src/worker/runtime/time-limits.ts", "src/worker/execution/job-executor.server.ts"],
  // LD-2b: the deadline derivation is defined once and called once.
  deriveUploadStageDeadlineMs: ["src/worker/runtime/time-limits.ts", "src/worker/execution/job-executor.server.ts"],
  executionLifetimeMs: [
    "src/worker/runtime/time-limits.ts",
    "src/worker/runtime/runtime.server.ts",
    "src/worker/state/sqlite-job-store.server.ts",
  ],
  retentionMs: [
    "src/worker/runtime/time-limits.ts",
    "src/worker/runtime/runtime.server.ts",
    "src/worker/state/sqlite-job-store.server.ts",
  ],
  EXECUTION_MARGIN_SECONDS: ["src/worker/runtime/time-limits.ts"],
  jobTtlMs: ["src/worker/state/sqlite-job-store.server.ts"],
});

function ld2aNameUses(file: string, source: string): Array<{ name: string; file: string; line: number }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: Array<{ name: string; file: string; line: number }> = [];
  const add = (node: ts.Node, name: string) =>
    out.push({ name, file: rel(file), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const visit = (node: ts.Node) => {
    let name: string | null = null;
    if (ts.isIdentifier(node)) name = node.text;
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) name = node.text;
    if (name !== null && Object.hasOwn(LD2A_NAMES, name)) add(node, name);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function ld2aViolations(graph: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of graph) {
    for (const use of ld2aNameUses(file, source)) {
      if (!LD2A_NAMES[use.name]!.includes(use.file)) out.push(`${use.file}:${use.line} ${use.name}`);
    }
  }
  return out;
}

describe("LD-2a/LD-2b: the lifetime is derived once, and UPLOAD_TIMEOUT reaches only the executor", () => {
  const graph = workerGraph();
  const real = (file: string) => readFileSync(join(ROOT, file), "utf8");
  const plant = (file: string, code: string): Overlay => ({ [file]: `${real(file)}\n${code}\n` });

  it("finds every LD-2a name only where the table allows it", () => {
    assert.deepEqual(ld2aViolations(graph), []);
  });

  it("positive controls: the scan sees each allowed use in the real graph", () => {
    const uses = [...graph].flatMap(([file, source]) => ld2aNameUses(file, source));
    const where = (name: string) => [...new Set(uses.filter((u) => u.name === name).map((u) => u.file))].sort();
    assert.deepEqual(where("uploadMs"), [
      "src/worker/execution/job-executor.server.ts",
      "src/worker/runtime/time-limits.ts",
    ]);
    assert.deepEqual(where("deriveUploadStageDeadlineMs"), [
      "src/worker/execution/job-executor.server.ts",
      "src/worker/runtime/time-limits.ts",
    ]);
    assert.deepEqual(where("EXECUTION_MARGIN_SECONDS"), ["src/worker/runtime/time-limits.ts"]);
    assert.deepEqual(where("executionLifetimeMs"), [...LD2A_NAMES.executionLifetimeMs!].sort());
    assert.deepEqual(where("retentionMs"), [...LD2A_NAMES.retentionMs!].sort());
    assert.deepEqual(where("jobTtlMs"), ["src/worker/state/sqlite-job-store.server.ts"]);
  });

  it("the derivation itself: exactly one sum of the four stage limits and the margin", () => {
    const text = real("src/worker/runtime/time-limits.ts").replace(/\s+/g, " ");
    const sums = text.match(/analysisMs \+ downloadTimeLimitMs \+ processingMs \+ uploadMs \+ EXECUTION_MARGIN_SECONDS \* 1000/g) ?? [];
    assert.equal(sums.length, 1);
  });

  it("LD-2b: the executor derives the upload deadline exactly once, from the durable transition and the claimed deadline", () => {
    const text = real("src/worker/execution/job-executor.server.ts").replace(/\s+/g, " ");
    const calls = text.match(/deriveUploadStageDeadlineMs\(\{[^}]*\}\)/g) ?? [];
    assert.equal(calls.length, 1, "one derivation per upload stage");
    assert.match(calls[0]!, /stageStartedAtMs: upRes\.job\.updatedAt,/, "the durable uploading transition's own instant");
    assert.match(calls[0]!, /uploadMs: this\.stageTimeLimits\.uploadMs,/, "the one model's upload limit");
    assert.match(calls[0]!, /executionDeadlineMs: job\.expiresAt,/, "the claimed job's execution deadline");
    // The lifecycle is handed the absolute deadline, never a duration.
    assert.match(text, /stage: \{ signal, deadlineMs: uploadDeadlineMs, clock: this\.getClock, timers: this\.backstopTimers, \}/);
  });

  for (const [label, file, code, name] of [
    ["the HTTP service reading uploadMs", "src/worker/http/business-service.server.ts", "export const ld2aPlantedA = (x: { uploadMs: number }) => x.uploadMs;", "uploadMs"],
    ["the upload lifecycle reading uploadMs", "src/worker/storage/upload-lifecycle.server.ts", "export const ld2aPlantedB = (x: { uploadMs: number }) => x.uploadMs;", "uploadMs"],
    ["the R2 writer reading uploadMs", "src/worker/storage/cloudflare-r2-writer.server.ts", "export const ld2aPlantedE = (x: { uploadMs: number }) => x.uploadMs;", "uploadMs"],
    ["the upload lifecycle deriving its own deadline", "src/worker/storage/upload-lifecycle.server.ts", 'import { deriveUploadStageDeadlineMs as ld2bPlanted } from "../runtime/time-limits.ts";\nvoid ld2bPlanted;', "deriveUploadStageDeadlineMs"],
    ["the HTTP view reading the lifetime", "src/worker/http/business-service.server.ts", "export const ld2aPlantedC = (x: { executionLifetimeMs: number }) => x.executionLifetimeMs;", "executionLifetimeMs"],
    ["the executor recomputing L from a margin", "src/worker/execution/job-executor.server.ts", "export const EXECUTION_MARGIN_SECONDS = 600;", "EXECUTION_MARGIN_SECONDS"],
    ["the runtime reviving the retired TTL", "src/worker/runtime/runtime.server.ts", "export const ld2aPlantedD = { jobTtlMs: 1 };", "jobTtlMs"],
  ] as const) {
    it(`catches ${label} (in-memory overlay)`, () => {
      const found = ld2aViolations(workerGraph(plant(file, code)));
      assert.ok(found.length >= 1, `${label}: nothing flagged`);
      assert.ok(found.every((f) => f.startsWith(`${file}:`) && f.endsWith(` ${name}`)), found.join("; "));
    });
  }

  it("never wrote anything: the real sources carry no planted marker", () => {
    for (const file of [
      "src/worker/execution/job-executor.server.ts",
      "src/worker/storage/upload-lifecycle.server.ts",
      "src/worker/storage/cloudflare-r2-writer.server.ts",
      "src/worker/http/business-service.server.ts",
      "src/worker/runtime/runtime.server.ts",
    ]) {
      assert.equal(real(file).includes("ld2aPlanted"), false, file);
      assert.equal(real(file).includes("ld2bPlanted"), false, file);
    }
  });
});
