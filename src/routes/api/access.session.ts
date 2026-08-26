import { createFileRoute } from "@tanstack/react-router";
import { handleAccessSession } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/access/session")({
  server: {
    handlers: {
      GET: async ({ request }) => handleAccessSession(request),
    },
  },
});
