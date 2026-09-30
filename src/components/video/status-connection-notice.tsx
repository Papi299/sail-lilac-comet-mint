import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StatusConnectivity } from "@/lib/downloader-state";

export const RECONNECTING_TITLE = "Connection interrupted. Reconnecting…";
export const RETRY_EXHAUSTED_TITLE = "We couldn't reconnect to the processing worker.";
export const STILL_RUNNING_MESSAGE = "Your download may still be running.";
export const RETRY_STATUS_LABEL = "Retry status";

/**
 * The status channel, not the job: shown under the last known progress while
 * the browser cannot reach the job's status. Nothing here says the download
 * failed, because nothing known says it did.
 */
export function StatusConnectionNotice({
  connectivity,
  onRetryStatus,
  onReset,
}: {
  connectivity: StatusConnectivity;
  onRetryStatus: () => void;
  onReset: () => void;
}) {
  if (connectivity === "connected") return null;

  if (connectivity === "reconnecting") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex gap-2.5 rounded-lg border border-border bg-muted/50 p-3 text-sm"
      >
        <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{RECONNECTING_TITLE}</p>
          <p className="text-muted-foreground">{STILL_RUNNING_MESSAGE}</p>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="flex gap-2.5 rounded-lg border border-border bg-muted/50 p-3 text-sm">
      <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <p className="font-medium">{RETRY_EXHAUSTED_TITLE}</p>
          <p className="text-muted-foreground">{STILL_RUNNING_MESSAGE}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button size="sm" className="w-full sm:w-auto" onClick={onRetryStatus}>
            {RETRY_STATUS_LABEL}
          </Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={onReset}>
            Start over
          </Button>
        </div>
      </div>
    </div>
  );
}
