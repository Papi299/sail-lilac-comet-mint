import { createFileRoute } from "@tanstack/react-router";
import { handleDownloadFile } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/download/$jobId/file")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleDownloadFile(request, params.jobId),
    },
  },
});
