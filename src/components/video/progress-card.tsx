import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import type { JobProgress } from "@/types/job";

export function ProgressCard({ job }: { job: JobProgress }) {
  const indeterminate = job.progress == null;
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Loader2 className="mt-0.5 size-5 animate-spin text-muted-foreground" />
        <div>
          <h2 className="text-lg font-medium tracking-tight">Preparing your video</h2>
          <p className="text-sm text-muted-foreground">{job.stageLabel}</p>
        </div>
      </div>
      <div className="space-y-2">
        <Progress value={job.progress ?? 0} indeterminate={indeterminate} />
        <div className="flex items-center justify-between text-sm tabular-nums text-muted-foreground">
          <span>{indeterminate ? "Working" : `${Math.round(job.progress ?? 0)}%`}</span>
          {job.eta != null && job.eta > 0 ? <span>{formatEta(job.eta)} remaining</span> : <span />}
        </div>
      </div>
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
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}
