import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { WORKER_ERROR_CODES } from "@/shared/worker/errors";
import {
  ClearHlsAcquisitionError,
  type ClearHlsAcquiredTs,
  type ClearHlsAcquisitionFailure,
  type ClearHlsAcquisitionProgress,
} from "./hls-fragment-acquisition.server.ts";
import {
  ClearHlsPreflightError,
  type ClearHlsAcquisitionPlan,
  type ClearHlsPreflightFailure,
} from "./hls-preflight.server.ts";
import type { ClearHlsProcessedMp4 } from "./hls-processing.server.ts";
import {
  CLEAR_HLS_ACQUISITION_ERROR_CODES,
  CLEAR_HLS_PREFLIGHT_ERROR_CODES,
  acquireSelectedClearHlsTs,
  processAcquiredClearHlsTs,
  type ClearHlsAcquisitionPrimitives,
} from "./hls-execution.server.ts";

/**
 * HLS-6: the clear-HLS ORCHESTRATION seam.
 *
 * Fakes throughout: no network, no DNS, no filesystem, no subprocess. What is
 * under test is composition and TRANSLATION — which primitive runs, in which
 * order, with what, and what public error each private refusal becomes.
 */

const MODULE_PATH = fileURLToPath(new URL("./hls-execution.server.ts", import.meta.url));
const HLS_DIR = dirname(MODULE_PATH);
const ROOT = join(HLS_DIR, "..", "..", "..");

const VERY_PRIVATE_HLS_TOKEN = "VERY_PRIVATE_HLS_TOKEN";
const PLAYLIST_URL = `https://media.example.invalid/hls/1080/media.m3u8?sig=${VERY_PRIVATE_HLS_TOKEN}`;

const PLAN = Object.freeze({
  operation: "clear-hls-remux",
  source: Object.freeze({ playlistUrl: PLAYLIST_URL, height: 1080 }),
} as const);

const ACQUISITION_PLAN: ClearHlsAcquisitionPlan = Object.freeze({
  segmentType: "mpegts",
  fragments: Object.freeze([Object.freeze({ url: "https://media.example.invalid/f/0.ts" })]),
  fragmentCount: 1,
});

const ARTIFACT: ClearHlsAcquiredTs = Object.freeze({
  filePath: "/work/job-1/hls-source.ts",
  segmentType: "mpegts",
  fileSize: 4096,
});

/**
 * Every member of HLS-2's closed refusal vocabulary, written out.
 *
 * Deliberately a literal list rather than something derived from the mapping
 * table: the table is what is under test, so deriving the cases from it would
 * make an omission invisible. A member added to `ClearHlsPreflightFailure`
 * without an entry here fails the totality case below.
 */
const PREFLIGHT_FAILURES: readonly ClearHlsPreflightFailure[] = [
  "invalid_playlist_url",
  "destination_rejected",
  "network_error",
  "timeout",
  "cancelled",
  "playlist_http_status",
  "playlist_encoding",
  "playlist_too_large",
  "playlist_invalid_utf8",
  "playlist_rejected",
  "fragment_url_invalid",
];

/** The same, for HLS-3. */
const ACQUISITION_FAILURES: readonly ClearHlsAcquisitionFailure[] = [
  "invalid_plan",
  "destination_rejected",
  "network_error",
  "timeout",
  "cancelled",
  "fragment_http_status",
  "fragment_encoding",
  "fragment_too_large",
  "aggregate_too_large",
  "output_error",
];

function primitives(over: Partial<ClearHlsAcquisitionPrimitives> = {}): ClearHlsAcquisitionPrimitives {
  return {
    preflight: async () => ACQUISITION_PLAN,
    acquire: async () => ARTIFACT,
    ...over,
  } as ClearHlsAcquisitionPrimitives;
}

function order(over: Record<string, unknown> = {}) {
  return {
    plan: PLAN,
    workDir: "/work/job-1",
    signal: new AbortController().signal,
    ...over,
  } as Parameters<typeof acquireSelectedClearHlsTs>[0];
}

async function refusal(run: () => Promise<unknown>, label: string): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof AppError, `${label}: must be an AppError`);
    return err;
  }
  assert.fail(`${label}: expected a refusal`);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. THE DOWNLOADING PHASE: HLS-2 THEN HLS-3 (§13)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 acquisition: preflight, then fragments, and nothing else", () => {
  it("hands HLS-2 exactly the plan's playlist URL and the caller's signal", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    await acquireSelectedClearHlsTs(
      order({ signal: controller.signal }),
      primitives({
        preflight: async (request) => {
          seen.push(request);
          return ACQUISITION_PLAN;
        },
      }),
    );
    assert.equal(seen.length, 1, "exactly one preflight");
    const request = seen[0] as { playlistUrl: string; signal: AbortSignal; timeoutMs?: number };
    assert.equal(request.playlistUrl, PLAYLIST_URL);
    assert.equal(request.signal, controller.signal);
    // HLS-2 owns its own budget, capped at the analysis window; this seam does
    // not invent a second policy for it.
    assert.equal(request.timeoutMs, undefined);
  });

  it("hands HLS-3 the EXACT plan HLS-2 produced, and this job's workDir", async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    await acquireSelectedClearHlsTs(
      order({ workDir: "/work/job-7", signal: controller.signal }),
      primitives({
        acquire: async (request) => {
          seen.push(request);
          return ARTIFACT;
        },
      }),
    );
    const request = seen[0] as {
      plan: ClearHlsAcquisitionPlan;
      workDir: string;
      signal: AbortSignal;
      timeoutMs?: number;
    };
    assert.equal(request.plan, ACQUISITION_PLAN, "the same object, not a rebuild");
    assert.equal(request.workDir, "/work/job-7");
    assert.equal(request.signal, controller.signal);
    assert.equal(request.timeoutMs, undefined, "omitted means the application download budget");
  });

  it("passes a narrowing acquisition budget through when one is given", async () => {
    let seen: number | undefined;
    await acquireSelectedClearHlsTs(
      order({ acquisitionTimeoutMs: 1234 }),
      primitives({
        acquire: async (request) => {
          seen = request.timeoutMs;
          return ARTIFACT;
        },
      }),
    );
    assert.equal(seen, 1234);
  });

  it("returns the HLS-3 artifact IDENTICALLY, so HLS-4 revalidates what was committed", async () => {
    const acquired = await acquireSelectedClearHlsTs(order(), primitives());
    assert.equal(acquired, ARTIFACT);
    assert.equal(acquired.segmentType, "mpegts");
  });

  it("does not request fragments when the preflight refuses", async () => {
    let acquireCalls = 0;
    await refusal(
      () =>
        acquireSelectedClearHlsTs(
          order(),
          primitives({
            preflight: async () => {
              throw new ClearHlsPreflightError("playlist_rejected", "encrypted");
            },
            acquire: async () => {
              acquireCalls += 1;
              return ARTIFACT;
            },
          }),
        ),
      "a refused preflight",
    );
    assert.equal(acquireCalls, 0, "HLS-3 must not run after an HLS-2 refusal");
  });

  it("passes HLS-3's truthful progress through untouched", async () => {
    const reported: ClearHlsAcquisitionProgress[] = [];
    await acquireSelectedClearHlsTs(
      order({ onProgress: (p: ClearHlsAcquisitionProgress) => reported.push(p) }),
      primitives({
        acquire: async (request) => {
          request.onProgress?.({
            progress: 50,
            downloadedBytes: 2048,
            totalBytes: null,
            speed: null,
            eta: null,
            stage: "downloading",
          });
          return ARTIFACT;
        },
      }),
    );
    assert.deepEqual(reported, [
      {
        progress: 50,
        downloadedBytes: 2048,
        totalBytes: null,
        speed: null,
        eta: null,
        stage: "downloading",
      },
    ]);
  });

  it("gives HLS-3 no progress callback when the caller asked for none", async () => {
    let hadCallback: boolean | null = null;
    await acquireSelectedClearHlsTs(
      order(),
      primitives({
        acquire: async (request) => {
          hadCallback = request.onProgress !== undefined;
          return ARTIFACT;
        },
      }),
    );
    assert.equal(hadCallback, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. FAILURE MAPPING (§19, §20)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 mapping: every private HLS-2 reason has an explicit public code", () => {
  it("covers the closed vocabulary exactly — no member missing, none invented", () => {
    assert.deepEqual(Object.keys(CLEAR_HLS_PREFLIGHT_ERROR_CODES).sort(), [...PREFLIGHT_FAILURES].sort());
    for (const code of Object.values(CLEAR_HLS_PREFLIGHT_ERROR_CODES)) {
      assert.ok((WORKER_ERROR_CODES as readonly string[]).includes(code), `${code} is existing`);
    }
  });

  it("is the reviewed table, member by member", () => {
    assert.deepEqual(CLEAR_HLS_PREFLIGHT_ERROR_CODES, {
      // The selected source cannot satisfy the supported v1 format contract.
      invalid_playlist_url: "FORMAT_UNAVAILABLE",
      playlist_encoding: "FORMAT_UNAVAILABLE",
      playlist_too_large: "FORMAT_UNAVAILABLE",
      playlist_invalid_utf8: "FORMAT_UNAVAILABLE",
      playlist_rejected: "FORMAT_UNAVAILABLE",
      fragment_url_invalid: "FORMAT_UNAVAILABLE",
      // The request or the destination failed.
      destination_rejected: "NETWORK_ERROR",
      network_error: "NETWORK_ERROR",
      playlist_http_status: "NETWORK_ERROR",
      timeout: "TIMEOUT",
      cancelled: "PROCESSING_FAILED",
    });
  });

  for (const reason of PREFLIGHT_FAILURES) {
    it(`maps ${reason} to ${CLEAR_HLS_PREFLIGHT_ERROR_CODES[reason]}`, async () => {
      const err = await refusal(
        () =>
          acquireSelectedClearHlsTs(
            order(),
            primitives({
              preflight: async () => {
                throw new ClearHlsPreflightError(reason);
              },
            }),
          ),
        reason,
      );
      assert.equal(err.code, CLEAR_HLS_PREFLIGHT_ERROR_CODES[reason]);
      assert.equal(err.message, ERROR_MESSAGES[CLEAR_HLS_PREFLIGHT_ERROR_CODES[reason]]);
    });
  }

  it("collapses an unexpected non-HLS error to PROCESSING_FAILED, message dropped", async () => {
    const err = await refusal(
      () =>
        acquireSelectedClearHlsTs(
          order(),
          primitives({
            preflight: async () => {
              throw new Error(`connect ECONNREFUSED media.example.invalid ${VERY_PRIVATE_HLS_TOKEN}`);
            },
          }),
        ),
      "an unexpected preflight error",
    );
    assert.equal(err.code, "PROCESSING_FAILED");
    assert.equal(err.message.includes(VERY_PRIVATE_HLS_TOKEN), false);
    assert.equal(err.message, ERROR_MESSAGES.PROCESSING_FAILED);
  });

  it("refuses a forged reason fail-closed rather than producing a codeless error", async () => {
    const forged = new ClearHlsPreflightError("network_error");
    (forged as { reason: string }).reason = "not_a_member";
    const err = await refusal(
      () =>
        acquireSelectedClearHlsTs(
          order(),
          primitives({
            preflight: async () => {
              throw forged;
            },
          }),
        ),
      "a forged reason",
    );
    assert.equal(err.code, "PROCESSING_FAILED");
  });
});

describe("HLS-6 mapping: every private HLS-3 reason has an explicit public code", () => {
  it("covers the closed vocabulary exactly", () => {
    assert.deepEqual(
      Object.keys(CLEAR_HLS_ACQUISITION_ERROR_CODES).sort(),
      [...ACQUISITION_FAILURES].sort(),
    );
    for (const code of Object.values(CLEAR_HLS_ACQUISITION_ERROR_CODES)) {
      assert.ok((WORKER_ERROR_CODES as readonly string[]).includes(code), `${code} is existing`);
    }
  });

  it("is the reviewed table, member by member", () => {
    assert.deepEqual(CLEAR_HLS_ACQUISITION_ERROR_CODES, {
      // Internal / local structural failure.
      invalid_plan: "PROCESSING_FAILED",
      output_error: "PROCESSING_FAILED",
      // Remote request failure.
      destination_rejected: "NETWORK_ERROR",
      network_error: "NETWORK_ERROR",
      fragment_http_status: "NETWORK_ERROR",
      // The source violates the FRAGMENT-level v1 contract.
      fragment_encoding: "FORMAT_UNAVAILABLE",
      fragment_too_large: "FORMAT_UNAVAILABLE",
      // The only aggregate-size refusal.
      aggregate_too_large: "TOO_LARGE",
      timeout: "TIMEOUT",
      cancelled: "PROCESSING_FAILED",
    });
  });

  it("keeps the per-fragment ceiling out of TOO_LARGE, where only the aggregate belongs", () => {
    // `fragment_too_large` is v1's own structural per-fragment ceiling. Telling
    // the user their video exceeds the product size limit because one segment
    // was oversized would be false.
    assert.equal(CLEAR_HLS_ACQUISITION_ERROR_CODES.fragment_too_large, "FORMAT_UNAVAILABLE");
    assert.equal(CLEAR_HLS_ACQUISITION_ERROR_CODES.aggregate_too_large, "TOO_LARGE");
    assert.equal(
      Object.entries(CLEAR_HLS_ACQUISITION_ERROR_CODES).filter(([, code]) => code === "TOO_LARGE")
        .length,
      1,
      "exactly one reason may mean TOO_LARGE",
    );
  });

  for (const reason of ACQUISITION_FAILURES) {
    it(`maps ${reason} to ${CLEAR_HLS_ACQUISITION_ERROR_CODES[reason]}`, async () => {
      const err = await refusal(
        () =>
          acquireSelectedClearHlsTs(
            order(),
            primitives({
              acquire: async () => {
                throw new ClearHlsAcquisitionError(reason);
              },
            }),
          ),
        reason,
      );
      assert.equal(err.code, CLEAR_HLS_ACQUISITION_ERROR_CODES[reason]);
      assert.equal(err.message, ERROR_MESSAGES[CLEAR_HLS_ACQUISITION_ERROR_CODES[reason]]);
    });
  }

  it("collapses an unexpected acquisition error to PROCESSING_FAILED", async () => {
    const err = await refusal(
      () =>
        acquireSelectedClearHlsTs(
          order(),
          primitives({
            acquire: async () => {
              throw new TypeError(`EACCES: /work/job-1/hls-source.ts ${VERY_PRIVATE_HLS_TOKEN}`);
            },
          }),
        ),
      "an unexpected acquisition error",
    );
    assert.equal(err.code, "PROCESSING_FAILED");
    assert.equal(err.message.includes(VERY_PRIVATE_HLS_TOKEN), false);
  });
});

describe("HLS-6 mapping: no private detail escapes", () => {
  it("puts no playlist URL, host or token in any mapped error", async () => {
    for (const reason of PREFLIGHT_FAILURES) {
      const err = await refusal(
        () =>
          acquireSelectedClearHlsTs(
            order(),
            primitives({
              preflight: async () => {
                throw new ClearHlsPreflightError(reason);
              },
            }),
          ),
        reason,
      );
      const text = `${err.message}\n${err.stack ?? ""}\n${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
      assert.equal(text.includes(VERY_PRIVATE_HLS_TOKEN), false, reason);
      assert.equal(text.includes("media.example.invalid"), false, reason);
      assert.equal(text.includes(reason), false, `${reason}: the private reason must not leak`);
      assert.equal("cause" in err && err.cause !== undefined, false, "no cause is attached");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. THE PROCESSING PHASE (§14, §21)
// ─────────────────────────────────────────────────────────────────────────────

const PROCESSED: ClearHlsProcessedMp4 = Object.freeze({
  filePath: "/work/job-1/hls-output.mp4",
  container: "mp4",
  fileSize: 8192,
});

describe("HLS-6 processing: HLS-4 verbatim, with its canonical errors preserved", () => {
  it("hands HLS-4 exactly the request it was given, and returns its result", async () => {
    const controller = new AbortController();
    let seen: unknown;
    const out = await processAcquiredClearHlsTs(
      {
        source: ARTIFACT,
        workDir: "/work/job-1",
        timeoutMs: 600_000,
        maxOutputBytes: 4_294_967_296,
        signal: controller.signal,
      },
      (async (request: unknown) => {
        seen = request;
        return PROCESSED;
      }) as never,
    );
    assert.equal(out, PROCESSED);
    const request = seen as { source: unknown; workDir: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal };
    assert.equal(request.source, ARTIFACT, "the exact HLS-3 artifact, never a rebuild");
    assert.equal(request.workDir, "/work/job-1");
    assert.equal(request.timeoutMs, 600_000);
    assert.equal(request.maxOutputBytes, 4_294_967_296);
    assert.equal(request.signal, controller.signal);
  });

  for (const code of ["PROCESSING_FAILED", "TOO_LARGE", "TIMEOUT"] as const) {
    it(`preserves HLS-4's canonical ${code} exactly`, async () => {
      const original = new AppError(code);
      const err = await refusal(
        () =>
          processAcquiredClearHlsTs(
            {
              source: ARTIFACT,
              workDir: "/work/job-1",
              timeoutMs: 1000,
              maxOutputBytes: 1000,
              signal: new AbortController().signal,
            },
            (async () => {
              throw original;
            }) as never,
          ),
        code,
      );
      assert.equal(err, original, "the AppError is rethrown, not reinterpreted");
      assert.equal(err.code, code);
    });
  }

  it("collapses a non-AppError to PROCESSING_FAILED with its message dropped", async () => {
    const err = await refusal(
      () =>
        processAcquiredClearHlsTs(
          {
            source: ARTIFACT,
            workDir: "/work/job-1",
            timeoutMs: 1000,
            maxOutputBytes: 1000,
            signal: new AbortController().signal,
          },
          (async () => {
            throw new RangeError(`ffmpeg died at /work/job-1 ${VERY_PRIVATE_HLS_TOKEN}`);
          }) as never,
        ),
      "an unexpected processing error",
    );
    assert.equal(err.code, "PROCESSING_FAILED");
    assert.equal(err.message, ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(err.message.includes(VERY_PRIVATE_HLS_TOKEN), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. THE MODULE ITSELF (§13, §32)
// ─────────────────────────────────────────────────────────────────────────────

/** Every non-test TypeScript file under `src/`. */
function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

describe("HLS-6 orchestration module: a seam, not a second implementation", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  /** The module with its prose removed, so a mention is not taken for a call. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export async function acquireSelectedClearHlsTs"));
    assert.equal(code.includes("Privacy"), false, "comments should be gone");
  });

  it("imports only the error vocabulary and the three HLS primitives", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [
      "@/lib/errors",
      "./hls-fragment-acquisition.server.ts",
      "./hls-preflight.server.ts",
      "./hls-processing.server.ts",
      "@/shared/worker/errors",
    ]);
  });

  it("performs no media work of its own during acquisition", () => {
    for (const forbidden of [
      "ffprobe",
      "ffmpeg",
      "convertMedia",
      "mergeSplitMedia",
      "probeLocalMedia",
      "runProcess",
      "spawn",
      "yt-dlp",
      "node:child_process",
    ]) {
      assert.equal(code.includes(forbidden), false, `the seam must not reference ${forbidden}`);
    }
  });

  it("opens no transport, and widens no request profile", () => {
    for (const forbidden of [
      "safeGet",
      "safeHttpRequest",
      "resolveSafeDestination",
      "fetch(",
      "node:http",
      "node:https",
      "node:dns",
      "node:net",
      "Cookie",
      "Authorization",
      "Referer",
      "User-Agent",
      "http_headers",
      "headers",
    ]) {
      assert.equal(code.includes(forbidden), false, `the seam must not reference ${forbidden}`);
    }
  });

  it("builds no upload, filename or object key", () => {
    for (const forbidden of [
      "buildDownloadFilename",
      "finalizeJobUpload",
      "objectKey",
      "contentDisposition",
      "ObjectStoreWriter",
    ]) {
      assert.equal(code.includes(forbidden), false, `the seam must not reference ${forbidden}`);
    }
  });

  it("persists nothing and logs nothing", () => {
    for (const forbidden of ["console.", "JSON.stringify", "writeFile", "sqlite", "store."]) {
      assert.equal(code.includes(forbidden), false, `the seam must not reference ${forbidden}`);
    }
  });

  it("is named by exactly one production module outside the HLS directory", () => {
    const importers = productionSourceFiles()
      .filter((file) => dirname(file) !== HLS_DIR)
      .filter((file) => readFileSync(file, "utf8").includes("hls-execution.server"))
      .map((file) => relative(ROOT, file).split("\\").join("/"));
    assert.deepEqual(importers, ["src/worker/execution/job-executor.server.ts"]);
  });

  it("lives in a Worker-private location, not a shared or browser one", () => {
    const rel = relative(ROOT, MODULE_PATH).split("\\").join("/");
    assert.ok(rel.startsWith("src/worker/hls/"));
    assert.equal(rel.startsWith("src/shared/"), false);
  });
});
