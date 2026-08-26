import { createFileRoute } from "@tanstack/react-router";
import { handleDownloadStatus } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/download/$jobId/status")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleDownloadStatus(request, params.jobId),
    },
  },
});
