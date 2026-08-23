import { createFileRoute } from "@tanstack/react-router";
import { AppError, jsonError } from "@/lib/errors";
import { getPublicJob } from "@/services/downloads/manager.server";

export const Route = createFileRoute("/api/download/$jobId/status")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const job = getPublicJob(params.jobId);
          if (!job) throw new AppError("NOT_FOUND");
          return Response.json(job);
        } catch (err) {
          return jsonError(err instanceof Error ? err : new Error("status"), "NOT_FOUND");
        }
      },
    },
  },
});
