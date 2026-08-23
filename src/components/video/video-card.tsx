import { Clock, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/utils";
import type { VideoMetadata } from "@/types/media";

export function VideoCard({ video }: { video: VideoMetadata }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted sm:w-56 sm:shrink-0">
        {video.thumbnail ? (
          <img
            src={video.thumbnail}
            alt=""
            className="size-full object-cover"
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            No thumbnail
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <h2 className="text-lg font-medium leading-snug tracking-tight sm:text-xl">{video.title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="muted" className="gap-1">
            <Globe className="size-3" />
            {video.source}
          </Badge>
          <Badge variant="muted" className="gap-1">
            <Clock className="size-3" />
            {formatDuration(video.duration)}
          </Badge>
        </div>
      </div>
    </div>
  );
}
