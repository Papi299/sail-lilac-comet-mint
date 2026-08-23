import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";
import { AppError, jsonError } from "@/lib/errors";
import { getJobOrThrow } from "@/services/downloads/manager.server";

export const Route = createFileRoute("/api/download/$jobId/file")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const job = getJobOrThrow(params.jobId);
          if (job.status !== "ready" || !job.outputPath) {
            throw new AppError("NOT_FOUND");
          }
          const fileStat = await stat(job.outputPath);
          const stream = Readable.toWeb(createReadStream(job.outputPath)) as ReadableStream<Uint8Array>;
          const filename = (job.filename || "video.bin").replace(/"/g, "");
          return new Response(stream, {
            headers: {
              "Content-Type": job.outputMime || "application/octet-stream",
              "Content-Length": String(fileStat.size),
              "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
              "Cache-Control": "no-store",
            },
          });
        } catch (err) {
          return jsonError(err instanceof Error ? err : new Error("file"), "NOT_FOUND");
        }
      },
    },
  },
});
