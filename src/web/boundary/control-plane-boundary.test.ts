import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { handleHealth } from "../health/health.server.ts";

/**
 * Static architecture gates for the Phase-7 traffic shift.
 *
 * These walk the real production module graph rather than grepping a single
 * file, so a legacy dependency reintroduced anywhere behind the browser-facing
 * API — at any depth — fails the build.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function readSource(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * Removes comments while preserving string and template literals, so a token
 * scan reflects real CODE rather than prose. Doc comments in these modules
 * legitimately name what they forbid.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec) found.push(spec);
  }
  return found;
}

/** Resolves an in-repo specifier to an absolute source file, or null. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith("@/")) {
    base = join(SRC, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = resolve(dirname(fromFile), spec);
  } else {
    return null; // bare package or node: builtin
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // Allow an explicit .ts specifier that already resolved above.
  return null;
}

/** Transitive production module graph reachable from an entry file. */
function productionGraph(entry: string, skip: string[] = []): Map<string, string> {
  const skipAbs = new Set(skip.map((p) => join(ROOT, p)));
  const graph = new Map<string, string>();
  const queue = [join(ROOT, entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file) || skipAbs.has(file)) continue;
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const source = readSource(file);
    graph.set(file, source);
    for (const spec of specifiers(source)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return graph;
}

function rel(file: string): string {
  return relative(ROOT, file);
}

const PRIVATE_API_ENTRY = "src/lib/security/private-access-api.server.ts";

const LEGACY_MEDIA_MODULES = [
  "src/services/downloads/manager.server.ts",
  "src/services/downloads/processor.server.ts",
  "src/services/extractors/registry.server.ts",
  "src/services/extractors/ytdlp.server.ts",
  "src/services/processing/ffmpeg.server.ts",
  "src/services/temp/files.server.ts",
];

describe("Vercel control-plane boundary", () => {
  const graph = productionGraph(PRIVATE_API_ENTRY);

  it("reaches a real module graph", () => {
    assert.ok(graph.size >= 10, `expected a real graph, saw ${graph.size} modules`);
    assert.ok(graph.has(join(ROOT, PRIVATE_API_ENTRY)));
  });

  it("has NO production import of any legacy local-media module", () => {
    for (const legacy of LEGACY_MEDIA_MODULES) {
      assert.equal(
        graph.has(join(ROOT, legacy)),
        false,
        `${legacy} is still reachable from the browser-facing private API`,
      );
    }
  });

  it("never mentions the legacy manager, processor, registry or yt-dlp by name", () => {
    const forbidden = [
      "downloads/manager.server",
      "downloads/processor.server",
      "extractors/registry.server",
      "extractors/ytdlp.server",
      "processing/ffmpeg.server",
      "temp/files.server",
      "getExtractorFor",
      "downloadWithYtdlp",
      "sampleExtractor",
      "enqueueDownload",
      "diagnosticsSnapshot",
    ];
    for (const [file, rawSource] of graph) {
      const source = stripComments(rawSource);
      for (const token of forbidden) {
        assert.equal(
          source.includes(token),
          false,
          `${rel(file)} references the legacy media stack via '${token}'`,
        );
      }
    }
  });

  it("imports no filesystem module anywhere behind the browser-facing API", () => {
    const fsLike = ["node:fs", "node:fs/promises", "fs", "fs/promises"];
    for (const [file, source] of graph) {
      for (const spec of specifiers(source)) {
        assert.equal(
          fsLike.includes(spec),
          false,
          `${rel(file)} imports ${spec} behind the browser-facing API`,
        );
      }
    }
  });

  it("uses no stream module for download delivery", () => {
    // The SSRF-pinned HTTP client is the single permitted node:stream consumer:
    // it exists to validate a URL before it is handed to the worker and is
    // never used to deliver bytes. Its request entry point must stay
    // unreachable from the control plane.
    const SAFE_HTTP = join(ROOT, "src/lib/security/safe-http.server.ts");
    const streamLike = ["node:stream", "node:stream/promises", "stream", "stream/promises"];

    for (const [file, source] of graph) {
      if (file !== SAFE_HTTP) {
        for (const spec of specifiers(source)) {
          assert.equal(
            streamLike.includes(spec),
            false,
            `${rel(file)} imports ${spec} on the delivery path`,
          );
        }
      }
      assert.equal(
        /\bcreateReadStream\b/.test(source),
        false,
        `${rel(file)} still streams local filesystem bytes`,
      );
      assert.equal(
        /\bReadable\.toWeb\b/.test(source),
        false,
        `${rel(file)} still adapts a local stream for delivery`,
      );
    }

    for (const [file, source] of graph) {
      if (file === SAFE_HTTP) continue;
      assert.equal(
        /\bsafeHttpRequest\b/.test(stripComments(source)),
        false,
        `${rel(file)} performs an HTTP body request in the control plane`,
      );
    }
  });

  it("generates no Content-Disposition in the control plane", () => {
    for (const [file, source] of graph) {
      assert.equal(
        source.includes("buildAttachmentContentDisposition"),
        false,
        `${rel(file)} still builds a Content-Disposition; Phase 4 metadata on the object is authoritative`,
      );
    }
  });

  it("routes every media operation through the worker client and the signer", () => {
    const entry = graph.get(join(ROOT, PRIVATE_API_ENTRY))!;
    assert.match(entry, /getWorkerClient\(\)\.analyze\(/);
    assert.match(entry, /getWorkerClient\(\)\.createJob\(/);
    assert.match(entry, /getWorkerClient\(\)\.getJob\(/);
    assert.match(entry, /getWorkerClient\(\)\.diagnostics\(\)/);
    assert.match(entry, /getObjectStoreSigner\(\)\.signGet\(/);
  });

  it("has no production fallback branch to a local media path", () => {
    // A fallback would have to import something; nothing in the graph may
    // reference the local media stack at all.
    for (const [file, source] of graph) {
      for (const spec of specifiers(source)) {
        assert.equal(
          /services\/(downloads|extractors|processing|temp|jobs)\//.test(spec),
          false,
          `${rel(file)} imports the local media stack via '${spec}'`,
        );
      }
    }
  });

  it("never lets the browser choose the principal or an idempotency key", () => {
    const entry = graph.get(join(ROOT, PRIVATE_API_ENTRY))!;
    assert.match(entry, /principalId: WORKER_PRIVATE_PRINCIPAL/);
    assert.equal(/body\?\.principalId/.test(entry), false);
    // The key must never be read from the browser request, in any form.
    assert.equal(/body\?\.idempotency/i.test(entry), false);
    assert.equal(/headers\.get\(\s*["'`]idempotency/i.test(entry), false);
    assert.equal(/idempotencyKey\s*[:=]/i.test(entry), false);
  });

  it("never exposes a worker or R2 secret to the browser bundle", () => {
    const secretNames = [
      "WORKER_CONTROL_SECRET",
      "WORKER_CONTROL_KEY_ID",
      "WORKER_BASE_URL",
      "R2_SIGNER_ACCESS_KEY_ID",
      "R2_SIGNER_SECRET_ACCESS_KEY",
      "R2_SIGNER_SESSION_TOKEN",
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      // Cloudflare Access service token. Vercel-only, like the signer identity:
      // the Worker runtime must never read it and the browser must never see it.
      "CLOUDFLARE_ACCESS_CLIENT_ID",
      "CLOUDFLARE_ACCESS_CLIENT_SECRET",
    ];
    for (const file of allSourceFiles()) {
      const source = readSource(file);
      for (const name of secretNames) {
        assert.equal(
          source.includes(`VITE_${name}`),
          false,
          `${rel(file)} exposes ${name} to the browser bundle`,
        );
      }
    }
    // The names themselves may only appear in server-only COMPOSITION layers
    // or tests. There are exactly three such layers, one per runtime: the
    // Vercel control-plane config, the Worker runtime config, and the trusted
    // R2 credential broker's config. None is reachable from the browser bundle
    // — the VITE_ scan above still covers every file, this one included.
    const allowed = [
      "src/web/config/worker-runtime.server.ts",
      "src/web/config/worker-runtime.server.test.ts",
      "src/web/boundary/control-plane-boundary.test.ts",
      // Worker-side environment boundary (Phase 8A). Reads the SHARED HMAC pair
      // and the object-store location; it must never consume R2_SIGNER_*, which
      // it names only to document that exclusion.
      "src/worker/runtime/config.server.ts",
      // Trusted broker environment boundary
      // (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001). This module runs on the VM
      // HOST, outside the media container and outside the browser bundle
      // entirely. It is the sole reader of the persistent R2 parent credential.
      "src/broker/r2/config.ts",
    ].map((p) => join(ROOT, p));
    for (const file of productionSourceFiles()) {
      if (allowed.includes(file)) continue;
      const source = readSource(file);
      for (const name of secretNames) {
        assert.equal(
          source.includes(name),
          false,
          `${rel(file)} reads ${name} outside the server-only composition layer`,
        );
      }
    }
  });

  it("never lets the Worker runtime read the Cloudflare Access service token", () => {
    // The generic scan above exempts the Worker's own environment boundary,
    // so the exclusion is asserted directly here. Access credentials are
    // configured on the VERCEL control plane only; no Worker module reads,
    // consumes or verifies them.
    //
    // Scope note: this is a source-level guarantee. Whether the access layer
    // strips the headers before the origin is provider behaviour and is NOT
    // asserted here — see CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001.
    const workerConfig = join(ROOT, "src/worker/runtime/config.server.ts");
    assert.ok(existsSync(workerConfig), "the Worker environment boundary must exist");
    const source = readSource(workerConfig);
    for (const name of ["CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET"]) {
      assert.equal(
        source.includes(name),
        false,
        `the Worker runtime must never reference ${name}`,
      );
    }
    // And no Worker-side file may reach for them at all.
    for (const file of productionSourceFiles()) {
      if (!rel(file).startsWith("src/worker/")) continue;
      const workerSource = readSource(file);
      assert.equal(
        /CLOUDFLARE_ACCESS/i.test(workerSource),
        false,
        `${rel(file)} must not reference the Cloudflare Access service token`,
      );
    }
  });
});

// ── Complete Vercel API route surface ───────────────────────────────────────

/**
 * Every production route entry point, not just the private-access helper.
 *
 * Scoping the gate to a single entry file is exactly how `/api/health` kept a
 * legacy `manager.server` dependency through Phase 7, so the assertion now
 * starts from each route file and walks its full transitive graph.
 */
function apiRouteFiles(): string[] {
  const dir = join(SRC, "routes", "api");
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

describe("Vercel API route surface", () => {
  const routes = apiRouteFiles();

  it("enumerates every production API route", () => {
    const names = routes.map((f) => relative(join(SRC, "routes", "api"), f));
    for (const expected of [
      "analyze.ts",
      "diagnostics.ts",
      "download.$jobId.file.ts",
      "download.$jobId.status.ts",
      "download.ts",
      "health.ts",
      "sites.ts",
    ]) {
      assert.ok(names.includes(expected), `route ${expected} is missing from the gate`);
    }
    assert.ok(routes.length >= 8, `expected the full route surface, saw ${routes.length}`);
  });

  it("no API route can reach the legacy media or job stack", () => {
    // Media execution AND legacy health/operational reporting are both banned.
    const banned = [...LEGACY_MEDIA_MODULES, "src/services/jobs/store.server.ts"];
    for (const route of routes) {
      const graph = productionGraph(relative(ROOT, route));
      for (const legacy of banned) {
        assert.equal(
          graph.has(join(ROOT, legacy)),
          false,
          `${rel(route)} can reach ${legacy}`,
        );
      }
    }
  });

  it("no API route imports the local media stack by specifier", () => {
    for (const route of routes) {
      const graph = productionGraph(relative(ROOT, route));
      for (const [file, source] of graph) {
        for (const spec of specifiers(stripComments(source))) {
          assert.equal(
            /services\/(downloads|extractors|processing|temp|jobs)\//.test(spec),
            false,
            `${rel(route)} → ${rel(file)} imports '${spec}'`,
          );
        }
      }
    }
  });

  it("no API route probes a binary, the filesystem, or legacy job state", () => {
    const forbidden = [
      "healthSnapshot",
      "diagnosticsSnapshot",
      "ffmpegAvailable",
      "ytdlpAvailable",
      "tempUsage",
      "listExtractors",
      "getExtractorFor",
      "enqueueDownload",
      "listJobs",
      "countActive",
    ];
    for (const route of routes) {
      const graph = productionGraph(relative(ROOT, route));
      for (const [file, rawSource] of graph) {
        const source = stripComments(rawSource);
        for (const token of forbidden) {
          assert.equal(
            source.includes(token),
            false,
            `${rel(route)} → ${rel(file)} references '${token}'`,
          );
        }
      }
    }
  });
});

// ── Vercel liveness contract ────────────────────────────────────────────────

describe("Vercel /api/health is a minimal, independent liveness check", () => {
  const HEALTH_HANDLER = join(SRC, "web/health/health.server.ts");
  const HEALTH_ROUTE = join(SRC, "routes/api/health.ts");

  it("responds 200 with exactly { status: \"ok\" } and no-store", async () => {
    const res = handleHealth();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = await res.json();
    assert.deepEqual(body, { status: "ok" });
    assert.deepEqual(Object.keys(body as object), ["status"]);
  });

  it("leaks no operational, binary, or configuration state", async () => {
    const serialized = JSON.stringify(await handleHealth().json());
    for (const leak of [
      "ffmpeg",
      "extractor",
      "ytdlp",
      "queue",
      "activeJobs",
      "queuedJobs",
      "tempBytes",
      "safeEgress",
      "worker",
      "objectKey",
      "R2_",
      "WORKER_",
    ]) {
      assert.equal(
        serialized.toLowerCase().includes(leak.toLowerCase()),
        false,
        `the liveness body exposes '${leak}'`,
      );
    }
  });

  it("performs zero calls: the handler module imports nothing at all", () => {
    // A module with no imports cannot reach the legacy manager, the worker
    // client, a binary probe, or the filesystem. This is a structural proof,
    // stronger than counting spy invocations.
    const graph = productionGraph(relative(ROOT, HEALTH_HANDLER));
    assert.equal(graph.size, 1, "the liveness handler must be self-contained");

    const source = stripComments(readSource(HEALTH_HANDLER));
    assert.deepEqual(specifiers(source), [], "the liveness handler must import nothing");
  });

  it("never references the legacy manager, a probe, or the worker client", () => {
    for (const file of [HEALTH_HANDLER, HEALTH_ROUTE]) {
      const source = stripComments(readSource(file));
      for (const token of [
        "healthSnapshot",
        "manager.server",
        "ffmpegAvailable",
        "ytdlpAvailable",
        "tempUsage",
        "getWorkerClient",
        "WorkerClient",
        "diagnostics",
      ]) {
        assert.equal(source.includes(token), false, `${rel(file)} references '${token}'`);
      }
    }
  });

  it("does not make Vercel liveness depend on worker reachability", () => {
    const graph = productionGraph(relative(ROOT, HEALTH_ROUTE));
    assert.equal(
      graph.has(join(SRC, "web/config/worker-runtime.server.ts")),
      false,
      "the health route can reach the worker composition layer",
    );
    for (const [, source] of graph) {
      assert.equal(stripComments(source).includes("getWorkerClient"), false);
    }
  });
});

describe("Worker execution boundary", () => {
  const serviceGraph = productionGraph("src/worker/http/business-service.server.ts", [
    // The diagnostics binary probe is the single permitted yt-dlp reference and
    // only ever runs a version check; it is asserted separately below.
    "src/worker/http/binaries.server.ts",
  ]);

  it("no worker business or execution module reaches yt-dlp or a generic registry", () => {
    // `ytdlp` alone is a legitimate DIAGNOSTICS FIELD NAME in the shared
    // contract, so the ban is on execution entry points and on the modules
    // that could actually run the binary against a user URL.
    const forbidden = [
      "yt-dlp",
      "yt_dlp",
      "downloadWithYtdlp",
      "ytdlpExtractor",
      "ytdlpAvailable",
      "getExtractorFor",
      "registry.server",
      "sampleExtractor",
      "spawnYtdlpNetwork",
      "resolveYtdlp",
    ];
    let workerModules = 0;
    for (const [file, rawSource] of serviceGraph) {
      const source = stripComments(rawSource);

      // Every module on the path — worker or shared — must import only the
      // direct-media extractor.
      for (const spec of specifiers(source)) {
        assert.equal(
          /extractors\/(registry|ytdlp|sample)/.test(spec),
          false,
          `${rel(file)} imports a non-direct extractor via '${spec}'`,
        );
      }

      // The token ban applies to WORKER modules. `src/lib/config.ts` is shared
      // and merely DEFINES the yt-dlp resolver for the legacy stack; the worker
      // path imports only the read-only isolation attestation from it, and the
      // import assertion above proves no extractor module is reachable.
      if (!file.startsWith(join(SRC, "worker") + "/")) continue;
      workerModules += 1;
      for (const token of forbidden) {
        assert.equal(
          source.includes(token),
          false,
          `${rel(file)} references '${token}' on the worker execution path`,
        );
      }
    }
    assert.ok(workerModules >= 5, `expected a real worker surface, saw ${workerModules}`);
  });

  it("the worker path imports nothing yt-dlp-capable from shared config", () => {
    const service = stripComments(
      readSource(join(ROOT, "src/worker/http/business-service.server.ts")),
    );
    // STRENGTHENED in Phase 10C1. Previously the service was permitted exactly
    // one shared-config binding, the `isYtdlpNetworkIsolated` attestation
    // getter. That attestation is retired: the yt-dlp feature state now travels
    // from the Worker runtime configuration boundary as an injected dependency,
    // so the business surface needs nothing from shared config at all.
    const configImport = service.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*lib\/config[^"']*["']/);
    assert.equal(
      configImport,
      null,
      "the worker business surface must not import from shared config at all",
    );

    for (const [file, rawSource] of serviceGraph) {
      if (!file.startsWith(join(SRC, "worker") + "/")) continue;
      const source = stripComments(rawSource);
      assert.equal(
        /\bresolveYtdlp\s*\(/.test(source),
        false,
        `${rel(file)} resolves the yt-dlp binary`,
      );
    }
  });

  it("no user URL can reach yt-dlp from the worker business surface", () => {
    // Analysis is the only place a user URL is interpreted, and it resolves to
    // the direct-media analyzer alone.
    const service = readSource(join(ROOT, "src/worker/http/business-service.server.ts"));
    assert.match(service, /analyzeDirectMedia/);
    assert.equal(service.includes("analyzeUrl"), false);
    assert.equal(service.includes("downloadMedia"), false);

    const direct = stripComments(
      readSource(join(ROOT, "src/worker/execution/direct-media.server.ts")),
    );
    for (const token of ["ytdlp", "yt-dlp", "yt_dlp", "getExtractorFor", "sampleExtractor"]) {
      assert.equal(direct.includes(token), false, `direct analysis references '${token}'`);
    }
  });

  it("the binary probe only performs a version check", () => {
    const raw = readSource(join(ROOT, "src/worker/http/binaries.server.ts"));
    // Comments are stripped before every token scan: this module's doc comment
    // legitimately NAMES the legacy extractor in order to state that it must
    // not be reached. Scanning prose would fail on the very sentence that
    // documents the boundary.
    const probe = stripComments(raw);
    assert.match(probe, /ffmpegAvailable/);

    // Phase 10C1 moved the yt-dlp half onto the Worker's OWN runtime module.
    // The probe must reach that module and NOT the legacy extractor, which
    // carries analyze and download entry points the Worker must never load.
    assert.match(probe, /probeYtdlpRuntime/);
    for (const spec of specifiers(probe)) {
      assert.equal(
        /extractors\//.test(spec),
        false,
        `the probe imports '${spec}' — it must not reach any legacy extractor`,
      );
    }
    assert.ok(
      specifiers(probe).some((spec) => /runtime\/ytdlp-runtime\.server/.test(spec)),
      "the probe must use the Worker-owned yt-dlp runtime module",
    );

    // No extraction, download or user-URL entry point may exist here.
    for (const token of ["downloadWithYtdlp", "ytdlpExtractor", "dumpInfo", "analyze", "url"]) {
      assert.equal(probe.includes(token), false, `the probe references '${token}'`);
    }
  });

  it("the worker runtime module is the only yt-dlp-capable module the worker loads", () => {
    // The Worker's yt-dlp surface is exactly one module, and it must remain a
    // RUNTIME foundation: no URL, no format selection, no output template, no
    // media dispatch. This is what keeps "the runtime is installed" from
    // quietly becoming "a user URL can be executed".
    const runtimeModule = join(ROOT, "src/worker/runtime/ytdlp-runtime.server.ts");
    const source = stripComments(readSource(runtimeModule));

    // Identifier-level tokens only. Scanning for bare option strings like
    // "-f" or "-o" would match inside unrelated flags ("--ffmpeg-location",
    // "--no-config-locations") and produce a test that fails for reasons
    // having nothing to do with the invariant. The ACTUAL argument policy is
    // asserted element-by-element in ytdlp-runtime.server.test.ts, where the
    // built argv can be inspected semantically instead of grepped.
    for (const token of [
      "getMetadata",
      "downloadWithYtdlp",
      "ytdlpExtractor",
      "registry.server",
      "getExtractorFor",
      "assertSafeUrl",
      "--output",
      "--format",
    ]) {
      assert.equal(
        source.includes(token),
        false,
        `the yt-dlp runtime module references '${token}', which would widen it beyond a runtime probe`,
      );
    }

    // It must not import anything that interprets a URL or plans media work.
    for (const spec of specifiers(source)) {
      assert.equal(
        /extractors\/|security\/ssrf|validation\/url|execution\//.test(spec),
        false,
        `the yt-dlp runtime module imports '${spec}'`,
      );
    }
  });

  it("the generic analysis modules are unreachable from the worker business surface", () => {
    // PHASE-10C2. A bounded generic yt-dlp ANALYZER and a direct-first strategy
    // router now exist under src/worker/analysis/. Neither may be reachable
    // from the authenticated HTTP surface in this phase: the invariant
    //
    //     authenticated request -> WorkerService -> direct-media analyzer only
    //
    // must still hold. Connecting them is a later, separately authorized task
    // that will replace this assertion deliberately rather than by accident.
    const GENERIC_ANALYZER = join(ROOT, "src/worker/analysis/ytdlp-analysis.server.ts");
    const STRATEGY_ROUTER = join(ROOT, "src/worker/analysis/media-analyzer.server.ts");

    assert.ok(existsSync(GENERIC_ANALYZER), "the generic analyzer must exist");
    assert.ok(existsSync(STRATEGY_ROUTER), "the strategy router must exist");

    assert.equal(
      serviceGraph.has(GENERIC_ANALYZER),
      false,
      "the generic yt-dlp analyzer is reachable from WorkerService",
    );
    assert.equal(
      serviceGraph.has(STRATEGY_ROUTER),
      false,
      "the strategy router is reachable from WorkerService",
    );

    for (const [file, rawSource] of serviceGraph) {
      const source = stripComments(rawSource);
      for (const token of ["analyzeGenericMedia", "analyzeMedia", "analysis/ytdlp-analysis", "analysis/media-analyzer"]) {
        assert.equal(
          source.includes(token),
          false,
          `${rel(file)} references '${token}' on the worker business path`,
        );
      }
    }
  });

  it("neither the runtime composition root nor the job executor reaches generic analysis", () => {
    // The composition root is where a generic analyzer would have to be injected
    // to become live, and the executor is where a generic download branch would
    // have to appear. Both are walked transitively.
    for (const entry of [
      "src/worker/runtime/runtime.server.ts",
      "src/worker/runtime/main.server.ts",
      "src/worker/execution/job-executor.server.ts",
    ]) {
      const graph = productionGraph(entry);
      for (const generic of [
        "src/worker/analysis/ytdlp-analysis.server.ts",
        "src/worker/analysis/media-analyzer.server.ts",
      ]) {
        assert.equal(
          graph.has(join(ROOT, generic)),
          false,
          `${entry} can reach ${generic}`,
        );
      }
    }
  });

  it("the generic analysis modules are worker-only and import no legacy extractor", () => {
    // They may use the shared SSRF boundary and the hardened process runner —
    // that is the point of them — but never the Vercel-era extractor stack, the
    // legacy global config, or FFmpeg.
    for (const file of [
      join(ROOT, "src/worker/analysis/ytdlp-analysis.server.ts"),
      join(ROOT, "src/worker/analysis/media-analyzer.server.ts"),
    ]) {
      const source = stripComments(readSource(file));
      for (const spec of specifiers(source)) {
        assert.equal(
          /extractors\/(registry|ytdlp|sample|normalize)/.test(spec),
          false,
          `${rel(file)} imports the legacy extractor stack via '${spec}'`,
        );
        assert.equal(
          /lib\/config/.test(spec),
          false,
          `${rel(file)} imports the legacy global config via '${spec}'`,
        );
        assert.equal(
          /processing\/ffmpeg/.test(spec),
          false,
          `${rel(file)} imports FFmpeg via '${spec}'`,
        );
      }
      for (const token of [
        "ytdlpExtractor",
        "downloadWithYtdlp",
        "dumpInfo",
        "assertYtdlpNetworkPolicy",
        "resolveYtdlp",
        "ytDlpFormatSelector",
        "mapExtractorMessage",
        "getExtractorFor",
        "isYtdlpNetworkIsolated",
        "YTDLP_NETWORK_ISOLATED",
      ]) {
        assert.equal(
          source.includes(token),
          false,
          `${rel(file)} reuses the legacy yt-dlp surface via '${token}'`,
        );
      }
      // They spawn nothing directly; the hardened runner owns the process group.
      assert.equal(source.includes("node:child_process"), false);
      assert.equal(/\bspawn\s*\(/.test(source), false);
    }
  });

  it("no Vercel API route can reach the generic analysis modules", () => {
    for (const route of apiRouteFiles()) {
      const graph = productionGraph(relative(ROOT, route));
      for (const generic of [
        "src/worker/analysis/ytdlp-analysis.server.ts",
        "src/worker/analysis/media-analyzer.server.ts",
      ]) {
        assert.equal(
          graph.has(join(ROOT, generic)),
          false,
          `${rel(route)} can reach ${generic}`,
        );
      }
    }
  });

  it("the worker HTTP surface has no live 501 business placeholder", () => {
    const server = readSource(join(ROOT, "src/worker/http/server.server.ts"));
    assert.equal(server.includes("501"), false, "a 501 placeholder is still present");
    assert.equal(server.includes("Not Implemented"), false);
    assert.match(server, /service\.analyze\(/);
    assert.match(server, /service\.createJob\(/);
    assert.match(server, /service\.getJob\(/);
    assert.match(server, /service\.cancelJob\(/);
    assert.match(server, /service\.diagnostics\(\)/);
  });

  it("nothing in the repository enables generic yt-dlp execution", () => {
    // REPLACED in Phase 10C1. The previous assertion required
    // `.env.example` to CARRY `YTDLP_NETWORK_ISOLATED=` unset. That variable is
    // retired: the Worker runtime now refuses to start if it is present at any
    // value, so an example file still declaring it would document a
    // configuration that cannot boot. The invariant it protected — no
    // production artefact may switch generic extraction on — is preserved
    // below and extended to the replacement flag.
    for (const file of productionSourceFiles()) {
      const source = readSource(file);
      for (const enabled of [
        "YTDLP_ENABLED=true",
        'YTDLP_ENABLED = "true"',
        'process.env.YTDLP_ENABLED = "true"',
      ]) {
        assert.equal(
          source.includes(enabled),
          false,
          `${rel(file)} enables generic yt-dlp execution`,
        );
      }
    }

    const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
    // The example must offer the flag, unset, so an operator sees the contract
    // without being handed an enabled one.
    assert.match(envExample, /^YTDLP_ENABLED=\s*$/m, "the feature flag must ship unset");
    // The retired variables must not be presented as live configuration. They
    // may still be NAMED in prose that documents their retirement, so the scan
    // is for an assignment at the start of a line, not for the bare name.
    for (const retired of ["YTDLP_NETWORK_ISOLATED", "YTDLP_PATH"]) {
      assert.doesNotMatch(
        envExample,
        new RegExp(`^\\s*${retired}=`, "m"),
        `${retired} is retired and must not be offered as configuration`,
      );
    }
  });
});

function productionSourceFiles(): string[] {
  return allSourceFiles().filter((f) => !/\.test\.tsx?$/.test(f));
}

function allSourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
