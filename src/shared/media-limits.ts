/**
 * The delivered-media ceiling a Worker applies when `MAX_FILE_SIZE` is unset
 * (MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001): exactly 4 GiB, 4,294,967,296 bytes.
 *
 * Pure data with no imports and no side effects. BOTH configuration readers —
 * the strict Worker runtime loader (`src/worker/runtime/config.server.ts`) and
 * the general `src/lib/config.ts`, which the final local-output gate and the
 * direct downloader read — take this one value, so the two can no longer
 * default to different ceilings. `src/shared/media-limits.test.ts` pins both
 * readers to the literal.
 *
 * Changing it is a CAPACITY change, not just a policy change: a successful job
 * may hold up to 2 × this ceiling in the media workspace at once (see
 * `src/worker/execution/workspace-capacity.ts`), and the Worker refuses to start
 * on a workspace smaller than that.
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024 * 1024;
