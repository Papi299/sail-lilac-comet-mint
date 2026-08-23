import { Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";
import type { JobProgress } from "@/types/job";

export function CompleteCard({
  job,
  onReset,
}: {
  job: JobProgress;
  onReset: () => void;
}) {
  const href = job.downloadUrl || "#";
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="size-4" />
        </span>
        <div>
          <h2 className="text-lg font-medium tracking-tight">Your video is ready</h2>
          <p className="text-sm text-muted-foreground">The file will expire automatically after a short period.</p>
        </div>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Row label="Filename" value={job.filename || "video"} />
        <Row label="Quality" value={job.quality || "—"} />
        <Row label="Format" value={job.container ? job.container.toUpperCase() : "—"} />
        <Row label="File size" value={formatBytes(job.fileSize)} />
      </dl>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild className="w-full sm:w-auto">
          <a href={href} download={job.filename ?? undefined}>
            <Download className="size-4" />
            Download File
          </a>
        </Button>
        <Button variant="outline" className="w-full sm:w-auto" onClick={onReset}>
          Download Another Video
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-medium">{value}</dd>
    </div>
  );
}
