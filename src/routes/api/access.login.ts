import { createFileRoute } from "@tanstack/react-router";
import { handleAccessLogin } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/access/login")({
  server: {
    handlers: {
      POST: async ({ request }) => handleAccessLogin(request),
    },
  },
});
