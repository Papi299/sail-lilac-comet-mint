import type { DirectExecutionPlan, ExecutionPlan, GenericExecutionPlan } from "./format-plan.ts";

/**
 * Media-workspace capacity policy (MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001).
 *
 * Pure arithmetic: no filesystem, no clock, no configuration read. The executor
 * and the startup gate both derive their requirement here, so the per-job
 * preflight and the startup refusal cannot disagree about what a job needs.
 *
 * The Worker executes ONE job at a time (`WORKER_MAX_CONCURRENT_JOBS = 1`), so
 * the workspace demand of the whole Worker is the demand of one job. What one
 * successful job can hold at once, in units of `maxFileSizeBytes`:
 *
 *   keep-original   1 × — the one acquired original IS the delivered artifact.
 *
 *   convert,        2 × — the original (<= max) and the FFmpeg output coexist
 *   extract-m4a,          until the executor unwinds, and a successful output
 *   extract-mp3           is <= max at the final local-output gate.
 *
 *   merge-split     2 × — video + audio (<= max COMBINED, SPLIT-03) and the
 *                         merged artifact (<= max, SPLIT-02) coexist until the
 *                         executor unwinds.
 *
 * These are the hard bounds of a SUCCESSFUL job. No padding is added: headroom
 * is a deployment property (the Production workspace verifier requires more),
 * not something this policy guesses.
 *
 * This module deliberately never names the generic runtime: both strategy
 * types are derived from `ExecutionPlan`, so it stays outside the reviewed set
 * of modules that may reference it.
 */
export type WorkspaceFootprint = 1 | 2;

type DirectStrategy = Extract<ExecutionPlan, { readonly direct: unknown }>["strategy"];
type GenericStrategy = Extract<ExecutionPlan, { readonly generic: unknown }>["strategy"];

/**
 * The part of an execution plan the policy reads: the strategy and the closed
 * operation vocabulary, nothing else. `ExecutionPlan` is assignable to it.
 */
export type WorkspacePlanShape =
  | {
      readonly strategy: DirectStrategy;
      readonly direct: { readonly operation: DirectExecutionPlan["operation"] };
    }
  | {
      readonly strategy: GenericStrategy;
      readonly generic: { readonly operation: GenericExecutionPlan["operation"] };
    };

/**
 * What a freshly started Worker must be able to hold: the largest footprint any
 * plan can have, so no advertised preset is guaranteed to fail on capacity.
 */
export const STARTUP_WORKSPACE_FOOTPRINT: WorkspaceFootprint = 2;

/**
 * The footprint of one trusted execution plan.
 *
 * Exhaustive over both closed operation vocabularies: adding an operation to
 * either plan schema is a compile error here until its footprint is decided. A
 * value that arrived past the type system (a cast, a corrupted plan) throws, so
 * the caller fails closed rather than guessing.
 */
export function workspaceFootprintForPlan(plan: WorkspacePlanShape): WorkspaceFootprint {
  if (plan.strategy === "direct") {
    const operation = plan.direct.operation;
    switch (operation) {
      case "keep-original":
        return 1;
      case "convert":
      case "extract-m4a":
      case "extract-mp3":
        return 2;
      default:
        return unknownOperation(operation);
    }
  }
  // The only other strategy. A forged plan without a generic operation throws
  // on the property access below, which the caller treats as a refusal.
  const operation = plan.generic.operation;
  switch (operation) {
    case "keep-original":
      return 1;
    case "extract-m4a":
    case "extract-mp3":
    case "merge-split":
      return 2;
    default:
      return unknownOperation(operation);
  }
}

/**
 * The free bytes a footprint requires under one ceiling, or `null` when no
 * honest requirement exists: a ceiling that is not a positive safe integer, a
 * footprint outside the closed set, or a product that overflows the
 * safe-integer range. Callers must treat `null` as a refusal, never as zero.
 */
export function requiredWorkspaceBytes(
  maxFileSizeBytes: number,
  footprint: WorkspaceFootprint,
): number | null {
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) return null;
  if (footprint !== 1 && footprint !== 2) return null;
  const required = maxFileSizeBytes * footprint;
  return Number.isSafeInteger(required) ? required : null;
}

function unknownOperation(value: never): never {
  void value;
  throw new Error("execution plan carries no known workspace footprint");
}
