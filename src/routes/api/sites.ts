import { createFileRoute } from "@tanstack/react-router";
import { handleSites } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/sites")({
  server: {
    handlers: {
      GET: async ({ request }) => handleSites(request),
    },
  },
});
