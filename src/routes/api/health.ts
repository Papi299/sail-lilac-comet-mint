import { createFileRoute } from "@tanstack/react-router";
import { healthSnapshot } from "@/services/downloads/manager.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const health = await healthSnapshot();
        const status = health.status === "ok" ? 200 : 503;
        return Response.json(health, { status });
      },
    },
  },
});
