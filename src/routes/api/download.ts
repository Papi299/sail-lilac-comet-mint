import { createFileRoute } from "@tanstack/react-router";
import { handleDownload } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/download")({
  server: {
    handlers: {
      POST: async ({ request }) => handleDownload(request),
    },
  },
});
