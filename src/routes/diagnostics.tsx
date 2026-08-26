import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/utils";

export const Route = createFileRoute("/diagnostics")({
  component: DiagnosticsPage,
});

type Diagnostics = {
  counts: { queued: number; active: number; completed: number; failed: number };
  disk: { bytes: number; files: number };
  averageProcessingMs: number | null;
  worker: { running: number; queue: number; maxConcurrent: number };
  limits: { maxFileSize: number; maxVideoDuration: number; expirationMinutes: number };
};

function DiagnosticsPage() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/diagnostics")
      .then(async (res) => {
        if (!res.ok) throw new Error("Diagnostics are not available in this environment.");
        setData((await res.json()) as Diagnostics);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl tracking-tight">Diagnostics</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Operator snapshot of aggregate job counts, workers, and temporary storage. Requires a configured
        private-access secret and a valid session even in local development. Not linked from public navigation.
      </p>
      {error ? <p className="mt-8 text-sm text-destructive">{error}</p> : null}
      {data ? (
        <div className="mt-8 space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Queued" value={String(data.counts.queued)} />
            <Stat label="Active" value={String(data.counts.active)} />
            <Stat label="Completed" value={String(data.counts.completed)} />
            <Stat label="Failed" value={String(data.counts.failed)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Worker</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
              <p>Running: {data.worker.running}</p>
              <p>Queue: {data.worker.queue}</p>
              <p>Max concurrent: {data.worker.maxConcurrent}</p>
              <p>Temp files: {data.disk.files}</p>
              <p>Temp size: {formatBytes(data.disk.bytes)}</p>
              <p>
                Avg process:{" "}
                {data.averageProcessingMs != null ? `${Math.round(data.averageProcessingMs / 1000)}s` : "—"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Limits</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
              <p>Max file: {formatBytes(data.limits.maxFileSize)}</p>
              <p>Max duration: {Math.round(data.limits.maxVideoDuration / 60)}m</p>
              <p>Expiry: {data.limits.expirationMinutes}m</p>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-2 font-display text-3xl tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
