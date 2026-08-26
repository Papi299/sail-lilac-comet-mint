import { createFileRoute } from "@tanstack/react-router";
import { handleAccessLogout } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/access/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => handleAccessLogout(request),
    },
  },
});
