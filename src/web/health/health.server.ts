/**
 * Vercel liveness boundary.
 *
 * This is the WEB uptime check and nothing more. It deliberately has ZERO
 * imports — not the legacy media stack, not the worker client, not the
 * filesystem — so that:
 *
 *  - Vercel liveness never depends on whether the Worker is reachable;
 *  - a liveness probe never spawns FFmpeg or yt-dlp, walks the temp directory,
 *    or touches in-memory job state;
 *  - no operational detail (queue depth, binary availability, safe-egress
 *    state, temp usage, job counts, configuration) is exposed unauthenticated.
 *
 * Worker liveness is `GET /v1/healthz` on the Worker itself. Worker and queue
 * operational state is `GET /v1/diagnostics`, reachable only through the
 * authenticated private `/api/diagnostics` route.
 */
export function handleHealth(): Response {
  return Response.json({ status: "ok" }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
