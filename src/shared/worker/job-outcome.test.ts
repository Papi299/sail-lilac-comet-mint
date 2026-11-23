import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import { WORKER_ERROR_CODES } from "./errors.ts";
import {
  ACQUISITION_STOP_FAILED_STAGE_LABELS,
  FAILED_JOB_STAGE_LABELS,
  WORKER_RESTART_STAGE_LABEL,
  failedJobStageLabelFor,
  failedJobStageLabelForFailure,
} from "./job-failure.ts";
import {
  DOWNLOAD_STALLED_STAGE_LABEL,
  DOWNLOAD_TIME_LIMIT_STAGE_LABEL,
  DOWNLOAD_TIMEOUT_MESSAGE,
  JOB_OUTCOME_KINDS,
  PUBLIC_FAILED_JOB_STAGE_LABELS,
  RESERVED_FAILED_JOB_STAGE_LABELS,
  classifyJobOutcome,
  isPublicFailedJobStageLabel,
  isReservedFailedJobStageLabel,
  publicFailedStageLabel,
  timeoutMessageForStage,
} from "./job-outcome.ts";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the closed outcome
 * vocabulary. Its two reserved stages stayed inert until a Worker that writes
 * them was built in the approved order; since
 * VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001 (source, not deployed) the
 * Worker writes them through one closed table, pinned at the end.
 */

const HOSTILE = "Download stalled: yt-dlp ERROR https://media.example/v.mp4?X-Amz-Signature=x /var/lib/videofetch";

describe("the failed-stage vocabularies", () => {
  it("leaves the Worker-written list exactly as the Worker writes it", () => {
    assert.deepEqual([...FAILED_JOB_STAGE_LABELS], [
      "Download failed",
      "Processing failed",
      "Upload failed",
      "Worker restarted",
    ]);
  });

  it("reserves exactly the two watchdog stages of the approved design (§6)", () => {
    assert.deepEqual([...RESERVED_FAILED_JOB_STAGE_LABELS], ["Download stalled", "Download time limit reached"]);
    assert.equal(DOWNLOAD_STALLED_STAGE_LABEL, "Download stalled");
    assert.equal(DOWNLOAD_TIME_LIMIT_STAGE_LABEL, "Download time limit reached");
    for (const label of RESERVED_FAILED_JOB_STAGE_LABELS) {
      assert.equal((FAILED_JOB_STAGE_LABELS as readonly string[]).includes(label), false, label);
    }
  });

  it("publishes the written stages followed by the reserved ones, nothing else", () => {
    assert.deepEqual([...PUBLIC_FAILED_JOB_STAGE_LABELS], [...FAILED_JOB_STAGE_LABELS, ...RESERVED_FAILED_JOB_STAGE_LABELS]);
    for (const label of PUBLIC_FAILED_JOB_STAGE_LABELS) assert.equal(isPublicFailedJobStageLabel(label), true, label);
    for (const label of RESERVED_FAILED_JOB_STAGE_LABELS) assert.equal(isReservedFailedJobStageLabel(label), true, label);
    for (const label of FAILED_JOB_STAGE_LABELS) assert.equal(isReservedFailedJobStageLabel(label), false, label);
    for (const other of [null, undefined, "", "Failed", "download stalled", "Download stalled ", "Time limit reached", HOSTILE, 7]) {
      assert.equal(isPublicFailedJobStageLabel(other), false, JSON.stringify(other));
      assert.equal(isReservedFailedJobStageLabel(other), false, JSON.stringify(other));
    }
  });
});

describe("publicFailedStageLabel", () => {
  it("forwards a written stage with any code, as before", () => {
    for (const label of FAILED_JOB_STAGE_LABELS) {
      for (const code of [...WORKER_ERROR_CODES, null]) {
        assert.equal(publicFailedStageLabel(label, code), label, `${label} / ${code}`);
      }
    }
  });

  it("forwards a reserved stage ONLY with TIMEOUT", () => {
    for (const label of RESERVED_FAILED_JOB_STAGE_LABELS) {
      assert.equal(publicFailedStageLabel(label, "TIMEOUT"), label);
      for (const code of [...WORKER_ERROR_CODES.filter((c) => c !== "TIMEOUT"), null]) {
        assert.equal(publicFailedStageLabel(label, code), null, `${label} / ${code}`);
      }
    }
  });

  it("forwards nothing outside the closed vocabulary", () => {
    for (const other of [null, undefined, "", "Failed", "downloading", "Downloading 42%", HOSTILE, 1]) {
      assert.equal(publicFailedStageLabel(other, "TIMEOUT"), null, JSON.stringify(other));
    }
  });
});

describe("the TIMEOUT message by stage", () => {
  it("is the approved copy for the reserved, processing and upload stages", () => {
    assert.equal(
      timeoutMessageForStage("Download stalled"),
      "The source stopped sending data, so VideoFetch stopped waiting.",
    );
    assert.equal(
      timeoutMessageForStage("Download time limit reached"),
      "The download was still running when it reached VideoFetch's maximum download time.",
    );
    assert.equal(timeoutMessageForStage("Processing failed"), "Processing took too long.");
    assert.equal(timeoutMessageForStage("Upload failed"), "Uploading the finished file took too long.");
  });

  it("claims no cause for a download-stage timeout this Worker cannot yet separate", () => {
    assert.equal(DOWNLOAD_TIMEOUT_MESSAGE, "The download didn't finish in time.");
    assert.equal(timeoutMessageForStage("Download failed"), DOWNLOAD_TIMEOUT_MESSAGE);
    assert.equal(timeoutMessageForStage(null), DOWNLOAD_TIMEOUT_MESSAGE);
    assert.equal(timeoutMessageForStage(WORKER_RESTART_STAGE_LABEL), DOWNLOAD_TIMEOUT_MESSAGE);
    // It must not say the source stopped responding (false for a slow source
    // that kept sending until the absolute limit), nor blame processing.
    for (const claim of [/process/i, /respond/i, /stopped sending/i, /maximum/i]) {
      assert.equal(claim.test(DOWNLOAD_TIMEOUT_MESSAGE), false, String(claim));
    }
  });

  it("never states that a download-stage timeout was a processing timeout", () => {
    for (const stage of ["Download failed", "Download stalled", "Download time limit reached", null] as const) {
      assert.equal(/process/i.test(timeoutMessageForStage(stage)), false, String(stage));
    }
  });

  it("leaves the shared canonical TIMEOUT text untouched (the Worker stores and envelopes it)", () => {
    assert.equal(ERROR_MESSAGES.TIMEOUT, "The video took too long to process.");
  });
});

describe("classifyJobOutcome: the required distinctions", () => {
  const failed = (errorCode: string | null, stageLabel: string | null) =>
    classifyJobOutcome({ status: "failed", errorCode, stageLabel });

  it("names each required ending differently", () => {
    const cases: Array<[string, ReturnType<typeof classifyJobOutcome>]> = [
      ["1 user cancellation", classifyJobOutcome({ status: "cancelled", errorCode: null, stageLabel: "Cancelled" })],
      ["2 absolute acquisition deadline", failed("TIMEOUT", "Download time limit reached")],
      ["3 inactivity stall", failed("TIMEOUT", "Download stalled")],
      ["4 processing timeout", failed("TIMEOUT", "Processing failed")],
      ["5 upload timeout", failed("TIMEOUT", "Upload failed")],
      ["6 Worker restart", failed("PROCESSING_FAILED", "Worker restarted")],
      ["8 source/network failure", failed("NETWORK_ERROR", "Download failed")],
      ["9 unclassified failure", failed("PROCESSING_FAILED", "Processing failed")],
    ];
    assert.deepEqual(
      cases.map(([, kind]) => kind),
      [
        "cancelled",
        "download_time_limit",
        "download_stalled",
        "processing_timeout",
        "upload_timeout",
        "worker_restarted",
        "source_failure",
        "unclassified",
      ],
    );
    assert.equal(new Set(cases.map(([, kind]) => kind)).size, cases.length, "pairwise distinct");
  });

  it("7: an unreachable Worker or a lost status connection is never a job outcome", () => {
    // It is not a Worker job code at all, so no committed job can carry it, and
    // no status of the kind the browser shows while reconnecting is an ending.
    assert.equal((WORKER_ERROR_CODES as readonly string[]).includes("WORKER_UNAVAILABLE"), false);
    assert.equal((JOB_OUTCOME_KINDS as readonly string[]).some((k) => /unavailable|connect/i.test(k)), false);
    for (const status of ["queued", "analyzing", "downloading", "processing", "uploading"]) {
      assert.equal(classifyJobOutcome({ status, errorCode: null, stageLabel: "Downloading" }), null, status);
    }
  });

  it("keeps a download-stage timeout apart from the deadline and the stall", () => {
    assert.equal(failed("TIMEOUT", "Download failed"), "download_timeout");
    assert.notEqual(failed("TIMEOUT", "Download failed"), failed("TIMEOUT", "Download time limit reached"));
    assert.notEqual(failed("TIMEOUT", "Download failed"), failed("TIMEOUT", "Download stalled"));
    assert.notEqual(failed("TIMEOUT", "Download stalled"), failed("TIMEOUT", "Download time limit reached"));
  });

  it("ignores a reserved stage that does not arrive with TIMEOUT", () => {
    assert.equal(failed("NETWORK_ERROR", "Download stalled"), "source_failure");
    assert.equal(failed("PROCESSING_FAILED", "Download time limit reached"), "unclassified");
  });

  it("claims no stage for a TIMEOUT whose stage is not recognised", () => {
    assert.equal(failed("TIMEOUT", null), "unclassified");
    assert.equal(failed("TIMEOUT", HOSTILE), "unclassified");
  });

  it("classifies by code for the remaining failures", () => {
    for (const code of ["NETWORK_ERROR", "VIDEO_UNAVAILABLE", "EXTRACTION_FAILED", "UNSUPPORTED_SITE", "ANALYSIS_FAILED", "FORMAT_UNAVAILABLE"]) {
      assert.equal(failed(code, "Download failed"), "source_failure", code);
    }
    for (const code of ["TOO_LARGE", "TOO_LONG"]) assert.equal(failed(code, "Download failed"), "limit_exceeded", code);
    for (const code of ["PROCESSING_FAILED", "EXTRACTOR_UNAVAILABLE", "SERVER_OVERLOAD", "RATE_LIMITED", "NOT_FOUND", "EXPIRED", null]) {
      assert.equal(failed(code, "Upload failed"), "unclassified", String(code));
    }
  });

  it("says nothing about a job that ended with a file or has not ended", () => {
    assert.equal(classifyJobOutcome({ status: "ready", errorCode: null, stageLabel: "Ready" }), null);
    assert.equal(classifyJobOutcome({ status: "downloading", errorCode: "TIMEOUT", stageLabel: "Download stalled" }), null);
  });

  it("returns only members of the closed set", () => {
    const seen = new Set<string>();
    for (const status of ["failed", "cancelled", "ready", "queued"]) {
      for (const errorCode of [...WORKER_ERROR_CODES, null]) {
        for (const stageLabel of [...PUBLIC_FAILED_JOB_STAGE_LABELS, null, "Failed", HOSTILE]) {
          const kind = classifyJobOutcome({ status, errorCode, stageLabel });
          if (kind !== null) seen.add(kind);
        }
      }
    }
    for (const kind of seen) assert.ok((JOB_OUTCOME_KINDS as readonly string[]).includes(kind), kind);
    assert.deepEqual([...seen].sort(), [...JOB_OUTCOME_KINDS].sort(), "every kind is reachable");
  });
});

// ── Activation: the Worker writes a reserved stage only through ONE closed table ──
//
// LD-4a pinned both reserved stages as INERT until a Worker that writes them
// was built in the approved order. VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001
// is that Worker change, so the inertness proof is replaced here by the
// narrower contract that now holds: the Worker names neither label anywhere but
// its one shared vocabulary table, imports nothing of this presentation
// contract, and its store writes a reserved stage only through the one function
// that honours a stop where it can be true (leaving `downloading`, beside
// `TIMEOUT`). The control-plane side of the contract above is unchanged.

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name) && !/\.fixtures\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every production file that runs in the Worker image, or that the Worker graph shares. */
const WORKER_SIDE_ROOTS = ["src/worker", "src/services", "src/broker"];

describe("the reserved stages are written by the Worker only through its closed acquisition-stop table", () => {
  const files = WORKER_SIDE_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)));

  it("scans a real Worker graph", () => {
    assert.ok(files.length > 50, `expected a real file set, saw ${files.length}`);
    assert.ok(files.some((f) => f.endsWith(join("src", "worker", "state", "sqlite-job-store.server.ts"))));
  });

  it("the Worker's table is exactly the reserved stages, in order, and still outside the written list", () => {
    assert.deepEqual(Object.values(ACQUISITION_STOP_FAILED_STAGE_LABELS), [...RESERVED_FAILED_JOB_STAGE_LABELS]);
    assert.equal(ACQUISITION_STOP_FAILED_STAGE_LABELS.inactivity, DOWNLOAD_STALLED_STAGE_LABEL);
    assert.equal(ACQUISITION_STOP_FAILED_STAGE_LABELS["time-limit"], DOWNLOAD_TIME_LIMIT_STAGE_LABEL);
    for (const label of RESERVED_FAILED_JOB_STAGE_LABELS) {
      assert.equal((FAILED_JOB_STAGE_LABELS as readonly string[]).includes(label), false, label);
    }
  });

  it("no Worker-side module names a reserved stage literally or imports the outcome contract", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const label of RESERVED_FAILED_JOB_STAGE_LABELS) {
        assert.equal(source.includes(label), false, `${relative(ROOT, file)} names "${label}"`);
      }
      assert.equal(/job-outcome/.test(source), false, `${relative(ROOT, file)} imports the outcome contract`);
    }
  });

  it("positive control: the same scan finds both labels in the shared Worker vocabulary and in the contract", () => {
    for (const rel of ["src/shared/worker/job-failure.ts", "src/shared/worker/job-outcome.ts"]) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const label of RESERVED_FAILED_JOB_STAGE_LABELS) assert.ok(text.includes(label), `${rel}: ${label}`);
    }
  });

  it("the store writes every failed stage through the one function that honours a stop only where it can be true", () => {
    const store = readFileSync(join(ROOT, "src/worker/state/sqlite-job-store.server.ts"), "utf8");
    assert.equal(store.split("failedJobStageLabelForFailure(leaving, validErrorCode, acquisitionStop)").length - 1, 1);
    assert.equal(store.includes("RESERVED_FAILED_JOB_STAGE_LABELS"), false);
    assert.equal(store.includes("ACQUISITION_STOP_FAILED_STAGE_LABELS"), false, "the table is read through the function only");
    // The function: a stop's stage only for `downloading` beside `TIMEOUT`.
    for (const cause of ["inactivity", "time-limit"] as const) {
      assert.equal(failedJobStageLabelForFailure("downloading", "TIMEOUT", cause), ACQUISITION_STOP_FAILED_STAGE_LABELS[cause]);
      for (const status of ["queued", "analyzing", "processing", "uploading"] as const) {
        assert.equal(failedJobStageLabelForFailure(status, "TIMEOUT", cause), failedJobStageLabelFor(status), status);
      }
      for (const code of WORKER_ERROR_CODES.filter((c) => c !== "TIMEOUT")) {
        assert.equal(failedJobStageLabelForFailure("downloading", code, cause), "Download failed", code);
      }
    }
    assert.equal(failedJobStageLabelForFailure("downloading", "TIMEOUT", undefined), "Download failed");
    assert.equal(failedJobStageLabelForFailure("downloading", "TIMEOUT", "stall" as never), "Download failed");
  });

  it("whatever the Worker writes, the control plane forwards it exactly as N4's contract already did", () => {
    for (const cause of ["inactivity", "time-limit"] as const) {
      const stage = failedJobStageLabelForFailure("downloading", "TIMEOUT", cause);
      assert.equal(publicFailedStageLabel(stage, "TIMEOUT"), stage);
      assert.equal(isPublicFailedJobStageLabel(stage), true);
      assert.notEqual(timeoutMessageForStage(publicFailedStageLabel(stage, "TIMEOUT")), DOWNLOAD_TIMEOUT_MESSAGE);
    }
  });
});
