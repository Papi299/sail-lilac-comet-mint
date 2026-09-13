import { statfs } from "node:fs/promises";
import { ensureTempRoot } from "@/services/temp/files.server";
import {
  STARTUP_WORKSPACE_FOOTPRINT,
  requiredWorkspaceBytes,
} from "../execution/workspace-capacity.ts";

/**
 * Startup media-workspace capacity gate (MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001).
 *
 * The product ceiling is a capacity contract. One successful job may hold up to
 * 2 × `MAX_FILE_SIZE` in the media workspace at once, and the Worker runs one
 * job at a time, so a Worker whose workspace filesystem cannot hold that has
 * no business advertising the ceiling: every large preset would be accepted and
 * then fail on ENOSPC.
 *
 * So before any state is opened and before anything listens, the filesystem
 * holding the temp root the executor will actually use must have BOTH
 *
 *   total bytes     >= 2 × MAX_FILE_SIZE, and
 *   available bytes >= 2 × MAX_FILE_SIZE (measured for an unprivileged
 *                                         process: `bavail`, not `bfree`).
 *
 * This is the application's own lower bound. The Production host verifier
 * (`deploy/bin/vf-media-workspace-verify`) independently requires more — the
 * 8 GiB peak plus 1 GiB of operational headroom — and proves the mount's
 * identity and hardening, which an unprivileged process cannot.
 *
 * The failure names the violated INVARIANT only: never a byte count, never a
 * path, never an underlying error message.
 */

export type MediaWorkspaceMeasurement = {
  readonly totalBytes: number;
  readonly availableBytes: number;
};

export const MEDIA_WORKSPACE_INVARIANTS = [
  "ceiling-invalid",
  "workspace-unavailable",
  "measurement-invalid",
  "total-below-minimum",
  "available-below-minimum",
] as const;

export type MediaWorkspaceInvariant = (typeof MEDIA_WORKSPACE_INVARIANTS)[number];

/** Startup-fatal. Carries only the name of the violated invariant. */
export class MediaWorkspaceCapacityError extends Error {
  readonly invariant: MediaWorkspaceInvariant;

  constructor(invariant: MediaWorkspaceInvariant) {
    super(`media workspace capacity invariant failed: ${invariant}`);
    this.name = "MediaWorkspaceCapacityError";
    this.invariant = invariant;
  }
}

/**
 * The pure decision: does one measured filesystem support `maxFileSizeBytes`?
 *
 * Throws `MediaWorkspaceCapacityError` when it does not. A ceiling with no
 * honest requirement (not a positive safe integer, or whose double overflows)
 * and a measurement that is not a plausible pair of byte counts are refusals,
 * never silently clamped.
 */
export function assertMediaWorkspaceCapacity(
  measurement: MediaWorkspaceMeasurement,
  maxFileSizeBytes: number,
): void {
  const required = requiredWorkspaceBytes(maxFileSizeBytes, STARTUP_WORKSPACE_FOOTPRINT);
  if (required === null) throw new MediaWorkspaceCapacityError("ceiling-invalid");

  const totalBytes: unknown = measurement?.totalBytes;
  const availableBytes: unknown = measurement?.availableBytes;
  if (
    !isByteCount(totalBytes) ||
    !isByteCount(availableBytes) ||
    availableBytes > totalBytes
  ) {
    throw new MediaWorkspaceCapacityError("measurement-invalid");
  }

  if (totalBytes < required) throw new MediaWorkspaceCapacityError("total-below-minimum");
  if (availableBytes < required) throw new MediaWorkspaceCapacityError("available-below-minimum");
}

/**
 * The production reader: `statfs` on the directory, read as bigint so a large
 * filesystem cannot lose precision. A value beyond MAX_SAFE_INTEGER is clamped
 * DOWN to it; that can never turn an insufficient filesystem into a sufficient
 * one, because every requirement it is compared with is itself a safe integer.
 */
export async function measureMediaWorkspaceFilesystem(
  directory: string,
): Promise<MediaWorkspaceMeasurement> {
  const fs = await statfs(directory, { bigint: true });
  return {
    totalBytes: clampToSafeInteger(fs.blocks * fs.bsize),
    availableBytes: clampToSafeInteger(fs.bavail * fs.bsize),
  };
}

export type MediaWorkspaceStartupDeps = {
  /**
   * Resolves (creating if absent) the temp root the executor places job
   * directories under, and returns it. Production: `ensureTempRoot`, the very
   * function `createJobDir` itself goes through.
   */
  readonly prepareDirectory?: () => Promise<string>;
  /** Production: `measureMediaWorkspaceFilesystem`. */
  readonly measure?: (directory: string) => Promise<MediaWorkspaceMeasurement>;
};

/**
 * The startup gate. Resolves only when the media workspace supports the
 * configured ceiling; otherwise rejects with `MediaWorkspaceCapacityError`.
 *
 * An invalid ceiling is refused before the filesystem is touched. Any failure
 * to prepare or measure the workspace is `workspace-unavailable`, with the
 * underlying error deliberately dropped.
 */
export async function verifyMediaWorkspaceAtStartup(
  maxFileSizeBytes: number,
  deps: MediaWorkspaceStartupDeps = {},
): Promise<void> {
  if (requiredWorkspaceBytes(maxFileSizeBytes, STARTUP_WORKSPACE_FOOTPRINT) === null) {
    throw new MediaWorkspaceCapacityError("ceiling-invalid");
  }
  const prepare = deps.prepareDirectory ?? ensureTempRoot;
  const measure = deps.measure ?? measureMediaWorkspaceFilesystem;

  let measurement: MediaWorkspaceMeasurement;
  try {
    const directory = await prepare();
    measurement = await measure(directory);
  } catch {
    throw new MediaWorkspaceCapacityError("workspace-unavailable");
  }
  assertMediaWorkspaceCapacity(measurement, maxFileSizeBytes);
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function clampToSafeInteger(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}
