import { createFileRoute } from "@tanstack/react-router";
import { config } from "@/lib/config";
import { AppError, jsonError } from "@/lib/errors";
import { clientIp } from "@/lib/request-ip.server";
import { consumeRateLimit } from "@/lib/security/rate-limit.server";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import { analyzeVideo } from "@/services/downloads/manager.server";

export const Route = createFileRoute("/api/analyze")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const ip = clientIp();
          if (!consumeRateLimit(`analyze:${ip}`, config.rateLimitPerMinute)) {
            throw new AppError("RATE_LIMITED");
          }
          const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
          const url = typeof body?.url === "string" ? body.url : "";
          const safe = await assertSafeUrl(url);
          const video = await analyzeVideo(safe.url);
          return Response.json({ success: true, video });
        } catch (err) {
          return jsonError(err instanceof Error ? err : new Error("analyze"), "ANALYSIS_FAILED");
        }
      },
    },
  },
});
