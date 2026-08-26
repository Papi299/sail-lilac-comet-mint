import { createFileRoute } from "@tanstack/react-router";
import { handleDiagnostics } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/diagnostics")({
  server: {
    handlers: {
      GET: async ({ request }) => handleDiagnostics(request),
    },
  },
});
