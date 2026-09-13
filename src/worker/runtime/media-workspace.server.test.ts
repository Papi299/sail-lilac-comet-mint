import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaWorkspaceCapacityError,
  assertMediaWorkspaceCapacity,
  measureMediaWorkspaceFilesystem,
  verifyMediaWorkspaceAtStartup,
  type MediaWorkspaceInvariant,
  type MediaWorkspaceMeasurement,
} from "./media-workspace.server.ts";
import { describeStartupFailure, startWorker } from "./main.server.ts";

// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: the startup media-workspace gate.
// Every capacity below is an injected number; nothing is allocated.

const FOUR_GIB = 4_294_967_296;
const EIGHT_GIB = 8_589_934_592;
const RETIRED_TMPFS_BYTES = 2_147_483_648;
const PLANNED_WORKSPACE_BYTES = 10_737_418_240;

function isInvariant(invariant: MediaWorkspaceInvariant) {
  return (err: unknown) => {
    assert.ok(err instanceof MediaWorkspaceCapacityError, String(err));
    assert.equal(err.invariant, invariant);
    // The failure names the invariant only: no byte count, no path.
    assert.doesNotMatch(err.message, /\d/);
    assert.doesNotMatch(err.message, /\//);
    return true;
  };
}

const measured = (totalBytes: number, availableBytes: number): MediaWorkspaceMeasurement => ({
  totalBytes,
  availableBytes,
});

describe("MAX-FILE-SIZE-4GIB: startup media-workspace capacity arithmetic", () => {
  it("the exact minimum for a 4 GiB ceiling is 8 GiB total AND available, and it passes", () => {
    assert.doesNotThrow(() => assertMediaWorkspaceCapacity(measured(EIGHT_GIB, EIGHT_GIB), FOUR_GIB));
  });

  it("one byte below the minimum total fails", () => {
    assert.throws(
      () => assertMediaWorkspaceCapacity(measured(EIGHT_GIB - 1, EIGHT_GIB - 1), FOUR_GIB),
      isInvariant("total-below-minimum"),
    );
  });

  it("one byte below the minimum available fails, however large the filesystem", () => {
    assert.throws(
      () => assertMediaWorkspaceCapacity(measured(PLANNED_WORKSPACE_BYTES, EIGHT_GIB - 1), FOUR_GIB),
      isInvariant("available-below-minimum"),
    );
  });

  it("refuses the retired 2 GiB Product tmpfs under the 4 GiB ceiling", () => {
    assert.throws(
      () => assertMediaWorkspaceCapacity(measured(RETIRED_TMPFS_BYTES, RETIRED_TMPFS_BYTES), FOUR_GIB),
      isInvariant("total-below-minimum"),
    );
  });

  it("accepts the planned 10 GiB workspace at its 9 GiB operational floor", () => {
    assert.doesNotThrow(() =>
      assertMediaWorkspaceCapacity(measured(PLANNED_WORKSPACE_BYTES, 9_663_676_416), FOUR_GIB),
    );
  });

  it("refuses a ceiling with no honest requirement, including one whose double overflows", () => {
    for (const ceiling of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      assert.throws(
        () => assertMediaWorkspaceCapacity(measured(PLANNED_WORKSPACE_BYTES, PLANNED_WORKSPACE_BYTES), ceiling),
        isInvariant("ceiling-invalid"),
        String(ceiling),
      );
    }
  });

  it("refuses an implausible measurement rather than clamping it", () => {
    const invalid: Array<[number, number]> = [
      [Number.NaN, EIGHT_GIB],
      [EIGHT_GIB, Number.NaN],
      [-1, 0],
      [EIGHT_GIB, -1],
      [EIGHT_GIB + 0.5, EIGHT_GIB],
      [Number.POSITIVE_INFINITY, EIGHT_GIB],
      [Number.MAX_SAFE_INTEGER + 2, EIGHT_GIB],
      // More available than exists.
      [EIGHT_GIB, EIGHT_GIB + 1],
    ];
    for (const [total, available] of invalid) {
      assert.throws(
        () => assertMediaWorkspaceCapacity(measured(total, available), FOUR_GIB),
        isInvariant("measurement-invalid"),
        `${total}/${available}`,
      );
    }
  });
});

describe("MAX-FILE-SIZE-4GIB: startup media-workspace gate", () => {
  it("prepares the executor's temp root, then measures exactly that directory", async () => {
    const order: string[] = [];
    await verifyMediaWorkspaceAtStartup(FOUR_GIB, {
      prepareDirectory: async () => {
        order.push("prepare");
        return "/srv/example/workspace";
      },
      measure: async (directory) => {
        order.push(`measure:${directory}`);
        return measured(PLANNED_WORKSPACE_BYTES, PLANNED_WORKSPACE_BYTES);
      },
    });
    assert.deepEqual(order, ["prepare", "measure:/srv/example/workspace"]);
  });

  it("refuses an invalid ceiling without touching the filesystem", async () => {
    let touched = false;
    await assert.rejects(
      verifyMediaWorkspaceAtStartup(Number.MAX_SAFE_INTEGER, {
        prepareDirectory: async () => {
          touched = true;
          return "/w";
        },
      }),
      isInvariant("ceiling-invalid"),
    );
    assert.equal(touched, false);
  });

  it("an unpreparable or unmeasurable workspace is workspace-unavailable, with the cause dropped", async () => {
    await assert.rejects(
      verifyMediaWorkspaceAtStartup(FOUR_GIB, {
        prepareDirectory: async () => {
          throw new Error("EACCES /tmp/videofetch SECRET-SENTINEL");
        },
      }),
      isInvariant("workspace-unavailable"),
    );
    await assert.rejects(
      verifyMediaWorkspaceAtStartup(FOUR_GIB, {
        prepareDirectory: async () => "/w",
        measure: async () => {
          throw new Error("statfs ENOENT SECRET-SENTINEL");
        },
      }),
      isInvariant("workspace-unavailable"),
    );
  });

  it("refuses the retired 2 GiB tmpfs end to end", async () => {
    await assert.rejects(
      verifyMediaWorkspaceAtStartup(FOUR_GIB, {
        prepareDirectory: async () => "/tmp/videofetch",
        measure: async () => measured(RETIRED_TMPFS_BYTES, RETIRED_TMPFS_BYTES),
      }),
      isInvariant("total-below-minimum"),
    );
  });

  it("the production reader measures a real filesystem as safe integers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vf-media-workspace-"));
    try {
      const reading = await measureMediaWorkspaceFilesystem(directory);
      assert.ok(Number.isSafeInteger(reading.totalBytes) && reading.totalBytes > 0);
      assert.ok(Number.isSafeInteger(reading.availableBytes) && reading.availableBytes >= 0);
      assert.ok(reading.availableBytes <= reading.totalBytes);
      await assert.rejects(measureMediaWorkspaceFilesystem(join(directory, "absent")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders a startup refusal by invariant name only", () => {
    assert.equal(
      describeStartupFailure(new MediaWorkspaceCapacityError("available-below-minimum")),
      "startup blocked: media workspace below 2 × MAX_FILE_SIZE (available-below-minimum)",
    );
  });
});

describe("MAX-FILE-SIZE-4GIB: startWorker refuses an undersized workspace before anything opens", () => {
  it("a 4 GiB default on the retired 2 GiB tmpfs never opens state, listens or installs handlers", async () => {
    // Deliberately NOT under /tmp: the runtime refuses durable state there,
    // and this test must reach the workspace gate, not a configuration error.
    const dataDirectory = await mkdtemp(join("/var/tmp", "vf-4gib-gate-"));
    const errors: string[] = [];
    const gatedCeilings: number[] = [];
    let exitCode: number | null = null;
    try {
      const runtime = await startWorker({
        env: {
          WORKER_DATA_DIRECTORY: dataDirectory,
          WORKER_CONTROL_KEY_ID: "worker-control-1",
          WORKER_CONTROL_SECRET: "0123456789abcdef0123456789abcdef",
          R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          R2_BUCKET: "videofetch-temp",
          R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
        },
        log: () => {},
        logError: (line) => errors.push(line),
        setExitCode: (code) => {
          exitCode = code;
        },
        onSignal: () => {
          throw new Error("no shutdown handler may be installed for a refused start");
        },
        verifyMediaWorkspace: (maxFileSizeBytes) => {
          gatedCeilings.push(maxFileSizeBytes);
          return verifyMediaWorkspaceAtStartup(maxFileSizeBytes, {
            prepareDirectory: async () => "/tmp/videofetch",
            measure: async () => measured(RETIRED_TMPFS_BYTES, RETIRED_TMPFS_BYTES),
          });
        },
      });

      assert.equal(runtime, null);
      assert.equal(exitCode, 1);
      assert.deepEqual(gatedCeilings, [FOUR_GIB], "the gate sees the validated 4 GiB default");
      assert.deepEqual(errors, [
        "[worker] startup blocked: media workspace below 2 × MAX_FILE_SIZE (total-below-minimum)",
      ]);
      assert.deepEqual(await readdir(dataDirectory), [], "no durable state was opened");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
