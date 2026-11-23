import { Film, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobProgress } from "@/types/job";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the video
 * heading for a job this page did not analyze itself — one restored after a
 * reload. Everything here comes from the job's own public status (the Worker's
 * title, thumbnail and source, and the chosen quality), never from storage.
 */
export function JobSummary({
  job,
}: {
  job: Pick<JobProgress, "title" | "thumbnail" | "source" | "quality" | "container">;
}) {
  const quality = [job.quality, job.container ? job.container.toUpperCase() : null].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted sm:w-56 sm:shrink-0">
        {job.thumbnail ? (
          <img
            src={job.thumbnail}
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
        <h2 className="break-words text-lg font-medium leading-snug tracking-tight sm:text-xl">
          {job.title || "Your video"}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {job.source ? (
            <Badge variant="muted" className="max-w-full gap-1">
              <Globe aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{job.source}</span>
            </Badge>
          ) : null}
          {quality ? (
            <Badge variant="muted" className="gap-1">
              <Film aria-hidden="true" className="size-3 shrink-0" />
              {quality}
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}
