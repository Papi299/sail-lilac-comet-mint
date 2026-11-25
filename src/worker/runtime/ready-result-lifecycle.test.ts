import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKER_TIMESTAMP_TOLERANCE_SECONDS } from "../../shared/worker/constants.ts";
import { ObjectStoreHeadSchema } from "../storage/writer.ts";
import { CommitReadyInputSchema } from "../state/job-store.ts";
import {
  DEFAULT_WORKER_TIME_LIMITS,
  DOWNLOAD_INACTIVITY_TIMEOUT_SECONDS,
  FILE_EXPIRATION_MINUTES_RANGE,
  R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS,
  R2_OBJECT_LIFECYCLE_AGE_MS,
  R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS,
  WorkerTimeLimitsError,
  buildWorkerTimeLimits,
  deriveReadyExpiresAtMs,
  isProviderLastModifiedAtMs,
} from "./time-limits.ts";

/**
 * VIDEOFETCH-LD5B-R2-RETENTION-LIFECYCLE-HARDENING-001 — the ready result's
 * expiry as pure arithmetic (PO-20):
 *
 *     expiresAt = min(finished + R, Last-Modified + 3,600,000 − 300,000)
 *
 * and the refusals that keep a missing, malformed or unusable provider
 * timestamp from ever producing a ready result. The durable store applies it
 * (`sqlite-ready-lifecycle.server.test.ts`); this file pins the derivation.
 * Rows are written in C − LM terms: the commit instant minus the provider's
 * whole-second Last-Modified.
 */

const LM = 1_795_599_531_000; // LD-5a C1's provider Last-Modified
const CREATED = LM - 1_200_000; // the job was created 20 minutes before the upload completed
const R_DEFAULT = 2_700_000;
const R_MAX = 3_300_000;
const CAP = 3_300_000;

const derive = (lastModifiedAtMs: number, readyCommitAtMs: number, retentionMs = R_DEFAULT, jobCreatedAtMs = CREATED, finishedAtMs: number | null = null) =>
  deriveReadyExpiresAtMs({ lastModifiedAtMs, readyCommitAtMs, finishedAtMs, retentionMs, jobCreatedAtMs });
const ready = (expiresAtMs: number) => ({ ok: true, expiresAtMs, providerSafeExpiresAtMs: LM + CAP });
const refused = (reason: string) => ({ ok: false, reason });

describe("LD-5b: the canonical lifecycle constants", () => {
  it("states the approved lifecycle age and safety margin", () => {
    assert.equal(R2_OBJECT_LIFECYCLE_AGE_MS, 3_600_000);
    assert.equal(R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS, 300_000);
  });

  it("ties the retention range to them: the maximum R is the lifecycle age less the margin; the default stays 45 min", () => {
    assert.equal(FILE_EXPIRATION_MINUTES_RANGE.max * 60_000, R2_OBJECT_LIFECYCLE_AGE_MS - R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS);
    assert.equal(FILE_EXPIRATION_MINUTES_RANGE.default * 60_000, 2_700_000);
    assert.equal(DEFAULT_WORKER_TIME_LIMITS.retentionMs, 2_700_000);
  });

  it("sizes the future bound at the system's existing clock-skew budget, the Worker's request-timestamp tolerance", () => {
    assert.equal(R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS, WORKER_TIMESTAMP_TOLERANCE_SECONDS * 1000);
    assert.equal(R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS, 300_000);
  });
});

describe("LD-5b: isProviderLastModifiedAtMs — whole-second epoch milliseconds only", () => {
  it("accepts a whole-second instant, zero and the largest whole second that is a safe integer", () => {
    for (const ok of [LM, 0, 1_000, 9_007_199_254_740_000]) assert.equal(isProviderLastModifiedAtMs(ok), true, String(ok));
  });

  it("refuses NaN (an invalid Date), ±Infinity, pre-1970, fractional, sub-second and unsafe values", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1_000, // the SDK's reading of "Wed, 31 Dec 1969 23:59:59 GMT"
      LM + 500, // the SDK's reading of a fractional-second date
      LM + 0.5,
      1_795_599_531_437, // a local millisecond clock reading
      Number.MAX_SAFE_INTEGER + 1,
      9_007_199_254_741_000, // a whole second past the safe integers
    ]) {
      assert.equal(isProviderLastModifiedAtMs(bad), false, String(bad));
    }
  });

  it("refuses non-numbers outright: a Date, a numeric string, null, undefined, a bigint, an object", () => {
    for (const bad of [new Date(LM), String(LM), null, undefined, BigInt(LM), { valueOf: () => LM }]) {
      assert.equal(isProviderLastModifiedAtMs(bad), false, String(bad));
    }
  });
});

describe("LD-5b: every schema gate refuses the same values on its own", () => {
  const head = (lastModifiedAtMs: unknown) => ({
    objectKey: `videofetch/jobs/${"a".repeat(32)}/${"b".repeat(32)}`,
    contentLength: 8,
    contentType: "video/mp4",
    contentDisposition: "attachment",
    lastModifiedAtMs,
  });
  const commit = (lastModifiedAtMs: unknown) => ({
    objectKey: `videofetch/jobs/${"a".repeat(32)}/${"b".repeat(32)}`,
    filename: "clip.mp4",
    fileSize: 8,
    mime: "video/mp4",
    quality: null,
    container: "mp4",
    lastModifiedAtMs,
  });
  const BAD = [undefined, null, String(LM), new Date(LM), Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1_000, LM + 500, 2 ** 53];

  it("ObjectStoreHeadSchema (the writers' and the finalizer's gate)", () => {
    assert.equal(ObjectStoreHeadSchema.safeParse(head(LM)).success, true);
    for (const bad of BAD) assert.equal(ObjectStoreHeadSchema.safeParse(head(bad)).success, false, String(bad));
    const missing = head(LM) as Record<string, unknown>;
    delete missing.lastModifiedAtMs;
    assert.equal(ObjectStoreHeadSchema.safeParse(missing).success, false, "the field is required");
  });

  it("CommitReadyInputSchema (the store's gate)", () => {
    assert.equal(CommitReadyInputSchema.safeParse(commit(LM)).success, true);
    for (const bad of BAD) assert.equal(CommitReadyInputSchema.safeParse(commit(bad)).success, false, String(bad));
    const missing = commit(LM) as Record<string, unknown>;
    delete missing.lastModifiedAtMs;
    assert.equal(CommitReadyInputSchema.safeParse(missing).success, false, "the field is required: no fallback to finished + R");
  });
});

describe("LD-5b: deriveReadyExpiresAtMs — the matrix in C − LM terms, exact oracles", () => {
  // Default R: the provider cap first binds at C − LM = 600,000 (= 3,300,000 − 2,700,000).
  for (const [cMinusLm, expected] of [
    [0, "configured"],
    [1_000, "configured"],
    [300_000, "configured"],
    [381_000, "configured"],
    [531_000, "configured"],
    [599_999, "configured"],
    [600_000, "tie"],
    [600_001, "provider"],
    [900_000, "provider"],
    [936_000, "provider"],
    [1_200_000, "provider"],
    [3_299_999, "provider"],
  ] as const) {
    it(`default R, C − LM = ${cMinusLm}: ${expected}`, () => {
      const c = LM + cMinusLm;
      const want = expected === "configured" ? c + R_DEFAULT : LM + CAP;
      assert.deepEqual(derive(LM, c, R_DEFAULT), ready(want));
      if (expected === "tie") assert.equal(c + R_DEFAULT, LM + CAP);
    });
  }

  // Maximum R: the cap binds from C − LM = 0; C − LM = −1 (a Worker clock 1 ms behind R2's) keeps the configured bound.
  for (const [cMinusLm, expected] of [
    [-1, "configured"],
    [0, "tie"],
    [1, "provider"],
    [1_000, "provider"],
    [300_000, "provider"],
    [381_000, "provider"],
    [531_000, "provider"],
    [900_000, "provider"],
    [936_000, "provider"],
    [1_200_000, "provider"],
    [3_299_999, "provider"],
  ] as const) {
    it(`maximum R, C − LM = ${cMinusLm}: ${expected}`, () => {
      const c = LM + cMinusLm;
      const want = expected === "configured" ? c + R_MAX : LM + CAP;
      assert.deepEqual(derive(LM, c, R_MAX), ready(want));
    });
  }

  it("C − LM = 3,299,999 leaves a window of exactly one millisecond: expiresAt = C + 1", () => {
    for (const r of [R_DEFAULT, R_MAX]) assert.deepEqual(derive(LM, LM + 3_299_999, r), ready(LM + 3_299_999 + 1));
  });

  it("C − LM = 3,300,000 (window exactly zero) and beyond: provider_window_elapsed, for both R", () => {
    for (const r of [R_DEFAULT, R_MAX]) {
      for (const cMinusLm of [3_300_000, 3_300_001, 3_600_000]) {
        assert.deepEqual(derive(LM, LM + cMinusLm, r), refused("provider_window_elapsed"), `R ${r} C−LM ${cMinusLm}`);
      }
    }
  });

  it("the configured bound counts from a recorded finish when the row already has one", () => {
    assert.deepEqual(derive(LM, LM + 10_000, R_DEFAULT, CREATED, LM + 2_000), ready(LM + 2_000 + R_DEFAULT));
  });
});

describe("LD-5b: deriveReadyExpiresAtMs — refusals, never a clamp", () => {
  it("refuses an invalid provider timestamp: invalid_last_modified", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1_000, LM + 500, LM + 0.25, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(derive(bad, LM + 1_000), refused("invalid_last_modified"), String(bad));
    }
  });

  it("refuses timestamps in the wrong units", () => {
    assert.deepEqual(derive(LM / 1000, LM + 1_000), refused("invalid_last_modified"), "seconds, not a whole second in ms");
    assert.deepEqual(derive(LM * 1000, LM + 1_000), refused("last_modified_in_future"), "milliseconds scaled again: far future");
    assert.deepEqual(derive(1_795_599_000, LM + 1_000), refused("provider_window_elapsed"), "whole seconds since 1970 read as ms");
  });

  it("accepts a Last-Modified up to the 300 s clock-skew budget after the commit, and refuses one beyond it", () => {
    const c = LM - 300_000; // the Worker's clock 300 s behind R2's
    assert.deepEqual(derive(LM, c, R_DEFAULT), ready(c + R_DEFAULT), "inside the budget: the configured bound binds");
    assert.deepEqual(derive(LM, LM - 301_000, R_DEFAULT), refused("last_modified_in_future"));
    assert.deepEqual(derive(253_402_300_799_000, LM), refused("last_modified_in_future"), "year 9999");
  });

  it("accepts a Last-Modified long before the job (a Worker clock ahead of R2's): the cap only shortens the result", () => {
    // Created 20 min before completion on the Worker's clock; R2's Last-Modified reads 10 min before creation.
    const lmEarly = CREATED - 600_000;
    assert.deepEqual(derive(lmEarly, CREATED + 60_000, R_DEFAULT), { ok: true, expiresAtMs: lmEarly + CAP, providerSafeExpiresAtMs: lmEarly + CAP });
  });

  it("refuses an expiry that would precede the job's creation instead of flooring it: expiry_before_job", () => {
    // The Worker's clock stepped back 10 s past the creation, with a 1 s retention: finished + R < created.
    assert.deepEqual(derive(CREATED - 5_000, CREATED - 10_000, 1_000), refused("expiry_before_job"));
    // Last-Modified 56 min before the creation, the commit after a 200 s backward step: LM + 55 min < created.
    assert.deepEqual(derive(CREATED - 3_360_000, CREATED - 200_000, R_DEFAULT), refused("expiry_before_job"));
  });

  it("accepts an expiry exactly at the job's creation: the expiry_before_job boundary is strict", () => {
    // The Worker's clock stepped back 10 s past the creation, with a 10 s retention: finished + R = created.
    assert.deepEqual(derive(CREATED - 5_000, CREATED - 10_000, 10_000), {
      ok: true,
      expiresAtMs: CREATED,
      providerSafeExpiresAtMs: CREATED - 5_000 + CAP,
    });
  });

  it("refuses a cap past the safe integers instead of overflowing", () => {
    // A 1 ms retention keeps `finished + R` representable, so the provider term is what overflows.
    const top = 9_007_199_254_740_000;
    assert.deepEqual(derive(top, top, 1, top - 60_000), refused("invalid_last_modified"));
  });

  it("refuses a malformed Worker instant or retention as a caller fault, by field name", () => {
    const field = (name: string) => (e: unknown) => e instanceof WorkerTimeLimitsError && e.field === name;
    assert.throws(() => derive(LM, Number.NaN), field("readyCommitAtMs"));
    assert.throws(() => derive(LM, -1), field("readyCommitAtMs"));
    assert.throws(() => derive(LM, LM, R_DEFAULT, Number.NaN), field("jobCreatedAtMs"));
    assert.throws(() => derive(LM, LM, R_DEFAULT, 1.5), field("jobCreatedAtMs"));
    assert.throws(() => derive(LM, LM, 0), field("retentionMs"));
    assert.throws(() => derive(LM, LM, Number.NaN), field("retentionMs"));
    assert.throws(() => derive(LM, LM, R_DEFAULT, CREATED, -1), field("finishedAtMs"));
    assert.throws(() => derive(LM, Number.MAX_SAFE_INTEGER, R_DEFAULT, 0), field("readyCommitAtMs"), "finished + R past the safe integers");
    assert.throws(() => derive(LM, LM, R_DEFAULT, 0, Number.MAX_SAFE_INTEGER - 1_000), field("finishedAtMs"), "a recorded finish + R past the safe integers");
  });

  it("judges an invalid value before any clock comparison", () => {
    assert.deepEqual(derive(-1_000, 0, R_DEFAULT, 0), refused("invalid_last_modified"));
    assert.deepEqual(derive(LM + 500, LM - 3_600_000, R_DEFAULT, 0), refused("invalid_last_modified"));
  });
});

describe("LD-5b: the margin is on R2's clock — it holds whatever the Worker's clock reads", () => {
  // δ = R2 clock − Worker clock. The object completes at R2 time `done`; the
  // Worker commits `lag` later (R2 time) and reads its own clock (R2 time − δ).
  // R2 deletes at LM + 3,600,000 on its own clock, and a signed GET is honoured
  // until at most `expiresAt` (the signer keeps X-Amz-Date + X-Amz-Expires
  // <= expiresAt, as a number R2 compares with its own clock).
  for (const delta of [-200_000, -1_000, 0, 1_000, 200_000]) {
    for (const r of [R_DEFAULT, R_MAX]) {
      for (const lag of [1_000, 381_000, 936_000]) {
        it(`δ = ${delta} ms, R = ${r}, commit ${lag} ms after completion: R2 deletes at least 300 s after the link ends`, () => {
          const done = 1_795_599_531_437; // R2 time
          const lm = Math.floor(done / 1000) * 1000;
          const workerNow = done + lag - delta;
          const result = derive(lm, workerNow, r, workerNow - 1_800_000);
          assert.equal(result.ok, true);
          const expiresAt = result.ok ? result.expiresAtMs : Number.NaN;
          assert.ok(expiresAt <= lm + CAP, "never past Last-Modified + 55 min");
          assert.ok(lm + 3_600_000 - expiresAt >= 300_000, "R2's deletion comes at least 300 s after every link's end");
        });
      }
    }
  }
});

describe("LD-5b readiness: the DOWNLOAD_TIME_LIMIT=9000 model is unchanged by the cap", () => {
  it("derives the LD-5b execution lifetime from the same strict inputs, with the retention untouched", () => {
    const model = buildWorkerTimeLimits({
      analysisTimeoutSeconds: 45,
      downloadTimeLimitSeconds: 9_000,
      downloadInactivityTimeoutSeconds: DOWNLOAD_INACTIVITY_TIMEOUT_SECONDS.default,
      processingTimeoutSeconds: 600,
      uploadTimeoutSeconds: 3_600,
      fileExpirationMinutes: FILE_EXPIRATION_MINUTES_RANGE.default,
    });
    assert.deepEqual(
      { ...model },
      {
        analysisMs: 45_000,
        downloadTimeLimitMs: 9_000_000,
        inactivityMs: 120_000,
        processingMs: 600_000,
        uploadMs: 3_600_000,
        retentionMs: 2_700_000,
        executionLifetimeMs: 13_845_000,
      },
    );
  });
});
