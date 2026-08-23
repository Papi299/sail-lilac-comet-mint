import { createFileRoute } from "@tanstack/react-router";
import { config } from "@/lib/config";
import { AppError, jsonError } from "@/lib/errors";
import { clientIp } from "@/lib/request-ip.server";
import { consumeRateLimit } from "@/lib/security/rate-limit.server";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { enqueueDownload } from "@/services/downloads/manager.server";

export const Route = createFileRoute("/api/download")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const ip = clientIp();
          if (!consumeRateLimit(`download:${ip}`, Math.max(8, Math.floor(config.rateLimitPerMinute / 2)))) {
            throw new AppError("RATE_LIMITED");
          }
          const body = (await request.json().catch(() => null)) as {
            url?: unknown;
            formatId?: unknown;
            title?: unknown;
            thumbnail?: unknown;
            source?: unknown;
          } | null;
          const url = typeof body?.url === "string" ? body.url : "";
          const formatId = typeof body?.formatId === "string" ? body.formatId : "";
          if (!formatId) throw new AppError("FORMAT_UNAVAILABLE");
          const safe = await assertSafeUrl(url);
          const job = await enqueueDownload({
            url: safe.url,
            formatId,
            ip,
            title: typeof body?.title === "string" ? body.title : null,
            thumbnail: typeof body?.thumbnail === "string" ? body.thumbnail : null,
            source: typeof body?.source === "string" ? body.source : null,
          });
          return Response.json(job);
        } catch (err) {
          return jsonError(err instanceof Error ? err : new Error("download"), "PROCESSING_FAILED");
        }
      },
    },
  },
});
