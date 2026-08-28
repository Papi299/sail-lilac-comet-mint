import { createFileRoute } from "@tanstack/react-router";
import { handleHealth } from "@/web/health/health.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => handleHealth(),
    },
  },
});
