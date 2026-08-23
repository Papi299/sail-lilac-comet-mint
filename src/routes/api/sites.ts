import { createFileRoute } from "@tanstack/react-router";
import { SITE_CATALOG } from "@/lib/sites-catalog";
import { listExtractors } from "@/services/extractors/registry.server";
import { ytdlpAvailable } from "@/services/extractors/ytdlp.server";
import { ffmpegAvailable } from "@/services/processing/ffmpeg.server";

export const Route = createFileRoute("/api/sites")({
  server: {
    handlers: {
      GET: async () => {
        const [ytdlp, ffmpeg] = await Promise.all([ytdlpAvailable(), ffmpegAvailable()]);
        return Response.json({
          extractors: listExtractors(),
          ytdlp,
          ffmpeg,
          sites: SITE_CATALOG,
          note: "Support depends on each website’s delivery method and can change without notice. Direct media files and publicly accessible archive sources are the most reliable.",
        });
      },
    },
  },
});
