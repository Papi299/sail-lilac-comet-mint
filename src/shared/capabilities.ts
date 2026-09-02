/**
 * Compile-time facts about what THIS BUILD contains.
 *
 * Deliberately a dependency-free module. Both the server control plane and the
 * browser diagnostics route need the same answer, and the alternative — the
 * route importing it from `private-access-api.server.ts` — would drag a
 * server-only module carrying the worker client, the object-store signer and
 * the SSRF boundary into the browser bundle.
 *
 * Nothing here may ever read the environment. These are statements about
 * SOURCE, not about a deployment.
 */

/**
 * Whether this build contains a generic yt-dlp execution path at all.
 *
 * True since `PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001`, which added
 * the path end to end: the direct-first strategy router on `/analyze`, durable
 * execution that re-derives its own strategy, and progressive HTTP(S)
 * acquisition with the pinned runtime.
 *
 * It says nothing about whether generic extraction is USABLE. That additionally
 * requires the pinned runtime to execute and the operator to have enabled the
 * feature — two facts this constant cannot know and must never imply.
 */
export const GENERIC_YTDLP_EXECUTION_IMPLEMENTED = true;
