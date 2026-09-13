import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STARTUP_WORKSPACE_FOOTPRINT,
  requiredWorkspaceBytes,
  workspaceFootprintForPlan,
  type WorkspaceFootprint,
  type WorkspacePlanShape,
} from "./workspace-capacity.ts";

// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: the pure media-workspace policy.
// Arithmetic only — nothing here touches a filesystem or allocates bytes.

const FOUR_GIB = 4_294_967_296;
const EIGHT_GIB = 8_589_934_592;

const PLAN_FOOTPRINTS: ReadonlyArray<readonly [string, WorkspacePlanShape, WorkspaceFootprint]> = [
  ["direct keep-original", { strategy: "direct", direct: { operation: "keep-original" } }, 1],
  ["direct convert", { strategy: "direct", direct: { operation: "convert" } }, 2],
  ["direct extract-m4a", { strategy: "direct", direct: { operation: "extract-m4a" } }, 2],
  ["direct extract-mp3", { strategy: "direct", direct: { operation: "extract-mp3" } }, 2],
  ["generic keep-original", { strategy: "yt-dlp", generic: { operation: "keep-original" } }, 1],
  ["generic extract-m4a", { strategy: "yt-dlp", generic: { operation: "extract-m4a" } }, 2],
  ["generic extract-mp3", { strategy: "yt-dlp", generic: { operation: "extract-mp3" } }, 2],
  ["generic merge-split", { strategy: "yt-dlp", generic: { operation: "merge-split" } }, 2],
];

describe("MAX-FILE-SIZE-4GIB: plan-aware media-workspace footprint", () => {
  it("keep-original needs one ceiling; every plan that produces a second artifact needs two", () => {
    for (const [label, plan, expected] of PLAN_FOOTPRINTS) {
      assert.equal(workspaceFootprintForPlan(plan), expected, label);
    }
  });

  it("covers every operation of both closed plan vocabularies exactly once", () => {
    assert.deepEqual(
      PLAN_FOOTPRINTS.map(([label]) => label).sort(),
      [
        "direct convert",
        "direct extract-m4a",
        "direct extract-mp3",
        "direct keep-original",
        "generic extract-m4a",
        "generic extract-mp3",
        "generic keep-original",
        "generic merge-split",
      ],
    );
  });

  it("at the 4 GiB ceiling: keep-original requires exactly 4 GiB, processing and split exactly 8 GiB", () => {
    assert.equal(requiredWorkspaceBytes(FOUR_GIB, 1), 4_294_967_296);
    assert.equal(requiredWorkspaceBytes(FOUR_GIB, 2), 8_589_934_592);
    for (const [label, plan, footprint] of PLAN_FOOTPRINTS) {
      assert.equal(
        requiredWorkspaceBytes(FOUR_GIB, workspaceFootprintForPlan(plan)),
        footprint === 1 ? FOUR_GIB : EIGHT_GIB,
        label,
      );
    }
  });

  it("a fresh Worker must hold the largest footprint any plan can have", () => {
    assert.equal(STARTUP_WORKSPACE_FOOTPRINT, 2);
    assert.equal(
      Math.max(...PLAN_FOOTPRINTS.map(([, plan]) => workspaceFootprintForPlan(plan))),
      STARTUP_WORKSPACE_FOOTPRINT,
    );
  });

  it("refuses a ceiling that is not a positive safe integer", () => {
    for (const ceiling of [0, -1, -FOUR_GIB, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(requiredWorkspaceBytes(ceiling, 1), null, `${ceiling} x1`);
      assert.equal(requiredWorkspaceBytes(ceiling, 2), null, `${ceiling} x2`);
    }
  });

  it("refuses a requirement whose multiple overflows the safe-integer range", () => {
    assert.equal(requiredWorkspaceBytes(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
    assert.equal(requiredWorkspaceBytes(Number.MAX_SAFE_INTEGER, 2), null);
    // 2 x 2^52 = 2^53, the first integer that is not safe.
    assert.equal(requiredWorkspaceBytes(2 ** 52, 2), null);
    assert.equal(requiredWorkspaceBytes(2 ** 52 - 1, 2), 2 ** 53 - 2);
  });

  it("refuses a footprint outside the closed set", () => {
    for (const footprint of [0, 3, 1.5, -1]) {
      assert.equal(requiredWorkspaceBytes(FOUR_GIB, footprint as WorkspaceFootprint), null, String(footprint));
    }
  });

  it("throws, rather than guessing, for an operation or strategy the type system never admitted", () => {
    const forged = [
      { strategy: "direct", direct: { operation: "transcode" } },
      { strategy: "yt-dlp", generic: { operation: "convert" } },
      { strategy: "ffmpeg", direct: { operation: "keep-original" } },
    ];
    for (const plan of forged) {
      assert.throws(() => workspaceFootprintForPlan(plan as unknown as WorkspacePlanShape), JSON.stringify(plan));
    }
  });
});
