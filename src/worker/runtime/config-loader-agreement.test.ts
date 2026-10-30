import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { config, parseLaxNumber } from "../../lib/config.ts";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "../../shared/media-limits.ts";
import {
  loadWorkerRuntimeConfig,
  WorkerRuntimeConfigError,
  type WorkerRuntimeConfig,
} from "./config.server.ts";

/**
 * VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001: the legacy module loader
 * (`src/lib/config.ts`) and the strict Worker loader read the same numeric
 * variables, and the Worker imports both.
 *
 * The rule pinned here: for EVERY value the strict loader accepts, the legacy
 * loader computes the same number. A value the strict loader rejects never
 * reaches the legacy loader inside the Worker, because the Worker does not
 * start — so for those the strict refusal is what is asserted.
 *
 * Before LD-1 the one disagreement was a whitespace-only value: the strict
 * loader read it as unset (the default), the legacy one as `Number("  ") === 0`
 * — a zero byte ceiling or a zero, i.e. disabled, request timeout.
 */

function strictEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
    WORKER_CONTROL_KEY_ID: "worker-control-1",
    WORKER_CONTROL_SECRET: "0123456789abcdef0123456789abcdef",
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET: "videofetch-temp",
    R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

type Media = WorkerRuntimeConfig["media"];

/** Every numeric variable BOTH loaders read, with both loaders' defaults. */
const SHARED = [
  { name: "ANALYSIS_TIMEOUT", strict: (m: Media) => m.analysisTimeoutSeconds, fallback: 45, min: 1, max: 3600 },
  {
    name: "MAX_FILE_SIZE",
    strict: (m: Media) => m.maxFileSizeBytes,
    fallback: DEFAULT_MAX_FILE_SIZE_BYTES,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  { name: "MAX_VIDEO_DURATION", strict: (m: Media) => m.maxVideoDurationSeconds, fallback: 7200, min: 1, max: 604_800 },
  // LD-2a caps the strict range at 55 (was 1440); the legacy loader has no range.
  { name: "FILE_EXPIRATION_MINUTES", strict: (m: Media) => m.fileExpirationMinutes, fallback: 45, min: 1, max: 55 },
  { name: "MAX_REDIRECTS", strict: (m: Media) => m.maxRedirects, fallback: 5, min: 0, max: 20 },
] as const;

/** Unset, empty, whitespace, ordinary, leading zeros, range ends, and malformed. */
function inputsFor(v: (typeof SHARED)[number]): Array<string | undefined> {
  return [
    undefined,
    "",
    " ",
    "   ",
    "\t",
    " \n ",
    "\r\n",
    "7",
    "45",
    "0045",
    ` ${v.min} `,
    String(v.min),
    String(v.max),
    ...(v.min > 0 ? [String(v.min - 1)] : []),
    String(v.max + 1),
    "1e3",
    "+45",
    "4.5",
    "-1",
    "0x10",
    "forty-five",
  ];
}

type StrictOutcome = { accepted: true; value: number } | { accepted: false; variables: readonly string[] };

function strictOutcome(name: string, raw: string | undefined, read: (m: Media) => number): StrictOutcome {
  try {
    return { accepted: true, value: read(loadWorkerRuntimeConfig(strictEnv({ [name]: raw })).media) };
  } catch (err) {
    assert.ok(err instanceof WorkerRuntimeConfigError, String(err));
    return { accepted: false, variables: err.variables };
  }
}

describe("loader agreement (VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001)", () => {
  for (const v of SHARED) {
    it(`${v.name}: the two loaders agree on every value the strict loader accepts`, () => {
      let compared = 0;
      for (const raw of inputsFor(v)) {
        const strict = strictOutcome(v.name, raw, v.strict);
        const lax = parseLaxNumber(raw, v.fallback);
        if (strict.accepted) {
          assert.equal(lax, strict.value, `${v.name}=${JSON.stringify(raw)}`);
          compared += 1;
        } else {
          // Refused at the startup gate, naming only this variable: the Worker
          // never runs with whatever the legacy loader would have computed.
          assert.deepEqual([...strict.variables], [v.name], `${v.name}=${JSON.stringify(raw)}`);
        }
      }
      assert.ok(compared >= 10, `${v.name}: a real comparison (${compared} accepted inputs)`);
    });

    it(`${v.name}: a whitespace-only value is the default in BOTH loaders, never zero`, () => {
      for (const blank of [" ", "   ", "\t", " \n "]) {
        const strict = strictOutcome(v.name, blank, v.strict);
        assert.deepEqual(strict, { accepted: true, value: v.fallback });
        assert.equal(parseLaxNumber(blank, v.fallback), v.fallback);
        assert.notEqual(parseLaxNumber(blank, v.fallback), 0);
      }
    });
  }

  it("keeps the legacy module rule otherwise unchanged", () => {
    assert.equal(parseLaxNumber(undefined, 600), 600);
    assert.equal(parseLaxNumber("", 600), 600);
    assert.equal(parseLaxNumber("0", 600), 0, "an explicit zero is still zero");
    assert.equal(parseLaxNumber("1e3", 600), 1000, "still lenient where the strict gate refuses");
    assert.equal(parseLaxNumber("-1", 600), 600);
    assert.equal(parseLaxNumber("abc", 600), 600);
    assert.equal(parseLaxNumber("Infinity", 600), 600);
    assert.equal(parseLaxNumber(" 12 ", 600), 12);
  });

  it("the legacy DOWNLOAD_TIMEOUT rule: whitespace is the default, not a 0 ms budget", () => {
    assert.equal(parseLaxNumber("   ", 600) * 1000, 600_000);
  });
});

describe("the legacy module loader cannot authorize a Worker-only time limit", () => {
  const source = readFileSync(new URL("../../lib/config.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("never reads DOWNLOAD_TIME_LIMIT or PROCESSING_TIMEOUT", () => {
    // Positive control: the scan sees real code.
    assert.ok(code.includes('num("DOWNLOAD_TIMEOUT", 600)'));
    assert.equal(code.includes("DOWNLOAD_TIME_LIMIT"), false);
    assert.equal(code.includes("PROCESSING_TIMEOUT"), false);
  });

  it("exposes no stage time-limit field", () => {
    for (const key of Object.keys(config)) {
      assert.equal(/timeLimit|processing/i.test(key), false, key);
    }
    assert.equal(Object.hasOwn(config, "downloadTimeLimitMs"), false);
    assert.equal(Object.hasOwn(config, "processingMs"), false);
  });
});
