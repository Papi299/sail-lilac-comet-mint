import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusConnectionNotice } from "@/components/video/status-connection-notice";
import type { StatusConnectivity } from "@/lib/downloader-state";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: shown after a
 * reload while the page reads the status of the job this tab was showing. Only
 * that status is requested — no new download starts — and nothing about the
 * job is shown until the Worker has answered for it. While the status cannot
 * be read, the same connection notice as for a running job explains it and
 * offers to retry or start over (starting over neither cancels the job nor
 * creates one).
 */

export const RESTORING_TITLE = "Checking on your download";
export const RESTORING_MESSAGE = "VideoFetch is reading its current status. Nothing new is started.";

export function RestoringCard({
  connectivity,
  onRetryStatus,
  onReset,
}: {
  connectivity: StatusConnectivity;
  onRetryStatus: () => void;
  onReset: () => void;
}) {
  const waiting = connectivity !== "retry_exhausted";
  return (
    <Card>
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          {waiting ? (
            <Loader2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground motion-safe:animate-spin" />
          ) : null}
          <div role="status" aria-live="polite" className="min-w-0">
            <h2 className="text-lg font-medium tracking-tight">{RESTORING_TITLE}</h2>
            <p className="text-sm text-muted-foreground">{RESTORING_MESSAGE}</p>
          </div>
        </div>
        <StatusConnectionNotice connectivity={connectivity} onRetryStatus={onRetryStatus} onReset={onReset} />
      </CardContent>
    </Card>
  );
}
