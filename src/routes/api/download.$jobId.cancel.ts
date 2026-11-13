import { createFileRoute } from "@tanstack/react-router";
import {
  handleDownloadCancel,
  handleDownloadCancelMethodNotAllowed,
} from "@/lib/security/private-access-api.server";

// POST only. Without `ANY`, another method would fall through to the page
// renderer; with it, every other method is refused with 405 before any access
// check or Worker call (HEAD resolves to `ANY` too: no `GET` handler exists).
export const Route = createFileRoute("/api/download/$jobId/cancel")({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleDownloadCancel(request, params.jobId),
      ANY: async () => handleDownloadCancelMethodNotAllowed(),
    },
  },
});
