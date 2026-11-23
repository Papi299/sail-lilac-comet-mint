import { useEffect, useState } from "react";
import { CircleDashed, Hourglass, Loader2, MoveRight, Radio, SatelliteDish } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { StatusConnectivity } from "@/lib/downloader-state";
import {
  DOWNLOADING_FOR_LABEL,
  DOWNLOAD_LIMIT_LABEL,
  ELAPSED_LABEL,
  WAITING_NOTICE_MESSAGE,
  WAITING_NOTICE_TITLE,
  formatClock,
  formatLimit,
  knownActivity,
  progressCardView,
} from "@/lib/job-activity-ui";
import { formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import type { JobActivityState, JobProgress } from "@/types/job";

/**
 * The running job's card. VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001
 * adds the elapsed time, the download time limit, the source's activity and the
 * waiting notice — all from the job's own status (see `job-activity-ui.ts`).
 *
 * Screen readers hear the stage when it changes and the waiting notice when it
 * appears; the clock and the activity line update visually only, so nothing is
 * announced every second.
 */

/** Re-renders once a second so the elapsed time moves between status reads. */
function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

const ACTIVITY_ICONS: Readonly<Record<JobActivityState, typeof Radio>> = {
  starting: CircleDashed,
  "awaiting-first-byte": Hourglass,
  receiving: Radio,
  waiting: Hourglass,
  "between-resources": MoveRight,
  "between-phases": MoveRight,
  unobserved: SatelliteDish,
};

export function ProgressCard({
  job,
  connectivity = "connected",
}: {
  job: JobProgress;
  connectivity?: StatusConnectivity;
}) {
  const nowMs = useNowMs(1000);
  const view = progressCardView(job, { connectivity, nowMs });
  const activity = view.activityLabel === null ? null : knownActivity(job);
  const ActivityIcon = activity ? ACTIVITY_ICONS[activity.state] : null;
  const indeterminate = job.progress == null;
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Loader2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight">Preparing your video</h2>
          <p className="text-sm text-muted-foreground">{job.stageLabel}</p>
          {view.stageDescription ? (
            <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {view.stageDescription}
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-2">
        <Progress aria-label="Download progress" value={job.progress ?? 0} indeterminate={indeterminate} />
        <div className="flex items-center justify-between gap-3 text-sm tabular-nums text-muted-foreground">
          <span>{indeterminate ? "Working" : `${Math.round(job.progress ?? 0)}%`}</span>
          {job.eta != null && job.eta > 0 ? <span>Estimated {formatEta(job.eta)} left</span> : <span />}
        </div>
      </div>
      {activity && ActivityIcon && view.activityLabel ? (
        <p className="flex items-start gap-2 text-sm" data-activity-state={activity.state}>
          <ActivityIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">{view.activityLabel}</span>
        </p>
      ) : null}
      {view.showWaitingNotice ? (
        <div role="status" aria-live="polite" className="space-y-1 rounded-lg border border-border bg-muted/50 p-3 text-sm">
          <p className="font-medium">{WAITING_NOTICE_TITLE}</p>
          <p className="text-muted-foreground">{WAITING_NOTICE_MESSAGE}</p>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Meta
          label="Transferred"
          value={
            job.downloadedBytes != null
              ? `${formatBytes(job.downloadedBytes)}${job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ""}`
              : "—"
          }
        />
        <Meta label="Speed" value={formatSpeed(job.speed)} />
        <Meta label="Status" value={job.status} />
        <Meta label={ELAPSED_LABEL} value={formatClock(view.elapsedSinceRequestSeconds)} />
        {view.downloadLimitSeconds !== null ? (
          <Meta label={DOWNLOAD_LIMIT_LABEL} value={formatLimit(view.downloadLimitSeconds)} />
        ) : null}
        {view.downloadingForSeconds !== null ? (
          <Meta label={DOWNLOADING_FOR_LABEL} value={formatClock(view.downloadingForSeconds)} />
        ) : null}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}
