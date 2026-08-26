import { createFileRoute } from "@tanstack/react-router";
import { handleAnalyze } from "@/lib/security/private-access-api.server";

export const Route = createFileRoute("/api/analyze")({
  server: {
    handlers: {
      POST: async ({ request }) => handleAnalyze(request),
    },
  },
});
