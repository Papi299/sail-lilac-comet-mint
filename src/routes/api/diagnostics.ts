import { createFileRoute } from "@tanstack/react-router";
import { config, isProd } from "@/lib/config";
import { AppError, jsonError } from "@/lib/errors";
import { diagnosticsSnapshot } from "@/services/downloads/manager.server";

function allowed(request: Request): boolean {
  if (!isProd()) return true;
  const token = config.diagnosticsToken;
  if (!token) return false;
  return request.headers.get("x-diagnostics-token") === token;
}

export const Route = createFileRoute("/api/diagnostics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          if (!allowed(request)) throw new AppError("FORBIDDEN");
          const data = await diagnosticsSnapshot();
          return Response.json(data);
        } catch (err) {
          return jsonError(err instanceof Error ? err : new Error("diagnostics"), "FORBIDDEN");
        }
      },
    },
  },
});
