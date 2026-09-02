import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/diagnostics")({
  component: DiagnosticsPage,
});

/**
 * Mirrors WorkerDiagnosticsSuccess. Only fields the Worker actually reports are
 * rendered — no local disk usage, in-memory completion counts, or average
 * processing time is fabricated, because the Worker contract does not supply them.
 */
type WorkerDiagnostics = {
  status: "ok" | "degraded";
  queueDepth: number;
  runningJobs: number;
  maxConcurrent: number;
  binaries: { ffmpeg: boolean; ytdlp: boolean };
  runtime: { ytdlpVersion: string | null };
  features: { ytdlpEnabled: boolean };
  safeEgress: { enforcement: "external"; policyVersion: string | null };
};

function DiagnosticsPage() {
  const [data, setData] = useState<WorkerDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/diagnostics")
      .then(async (res) => {
        if (!res.ok) throw new Error("Diagnostics are not available in this environment.");
        setData((await res.json()) as WorkerDiagnostics);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl tracking-tight">Diagnostics</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Operator snapshot of the processing worker: queue depth, running jobs, and binary
        availability. Requires a configured private-access secret and a valid session even in local
        development. Not linked from public navigation.
      </p>
      {error ? <p className="mt-8 text-sm text-destructive">{error}</p> : null}
      {data ? (
        <div className="mt-8 space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Status" value={data.status} />
            <Stat label="Queue depth" value={String(data.queueDepth)} />
            <Stat label="Running jobs" value={String(data.runningJobs)} />
            <Stat label="Max concurrent" value={String(data.maxConcurrent)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Binaries</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
              <p>FFmpeg: {data.binaries.ffmpeg ? "available" : "missing"}</p>
              <p>
                yt-dlp runtime: {data.binaries.ytdlp ? "available" : "missing"}
                {data.runtime.ytdlpVersion ? ` (${data.runtime.ytdlpVersion})` : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generic extraction</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {/* Deliberately "configuration", not "feature enabled". The
                  setting records operator intent; it does not make generic
                  extraction operational, because this build contains no
                  execution path for it. Calling it "enabled" would imply a
                  capability that does not exist. */}
              <p>
                yt-dlp configuration: {data.features.ytdlpEnabled ? "enabled" : "disabled"}
              </p>
              <p>Generic yt-dlp execution: not implemented in this build</p>
              <p className="text-muted-foreground">
                Neither an available runtime nor an enabled setting makes generic extraction
                usable. This build has no generic analyze or download path, so only direct media
                files are extractable.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Safe egress</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p>Enforcement: {data.safeEgress.enforcement}</p>
              <p>Policy version: {data.safeEgress.policyVersion ?? "—"}</p>
              {/* The Worker holds no NET_ADMIN and cannot read the ruleset, so
                  it must not imply it has verified anything. */}
              <p className="text-muted-foreground">
                Egress is enforced outside this container by the media network namespace and its
                host-owned policy. The worker cannot inspect or attest that boundary.
              </p>
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
