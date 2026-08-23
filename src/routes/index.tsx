import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { UrlInput } from "@/components/video/url-input";
import { VideoCard } from "@/components/video/video-card";
import { FormatSelector } from "@/components/video/format-selector";
import { ProgressCard } from "@/components/video/progress-card";
import { CompleteCard } from "@/components/video/complete-card";
import { DownloadHistory } from "@/components/video/history";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  analyzeVideo,
  getJobStatus,
  loadHistory,
  rememberUrl,
  saveHistoryItem,
  startDownload,
  type HistoryItem,
} from "@/lib/client-api";
import type { VideoMetadata } from "@/types/media";
import type { JobProgress } from "@/types/job";

export const Route = createFileRoute("/")({ component: Home });

type Phase = "idle" | "analyzing" | "ready" | "processing" | "complete" | "error";

function Home() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [simpleMode, setSimpleMode] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [job, setJob] = useState<(JobProgress & { jobId?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    if (phase !== "processing" || !job || !("jobId" in job) || !job.jobId) return;
    const jobId = job.jobId;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getJobStatus(jobId)
        .then((next) => {
          if (cancelled) return;
          setJob(next);
          if (next.status === "ready") {
            setPhase("complete");
            saveHistoryItem({
              jobId,
              title: next.title || video?.title || "Video",
              thumbnail: next.thumbnail || video?.thumbnail || null,
              status: "ready",
              format: next.container,
              quality: next.quality,
              completedAt: Date.now(),
            });
            setHistory(loadHistory());
          } else if (next.status === "failed") {
            setPhase("error");
            setError(next.error || "We couldn't process this video. Try another format or source.");
            saveHistoryItem({
              jobId,
              title: next.title || video?.title || "Video",
              thumbnail: next.thumbnail || video?.thumbnail || null,
              status: "failed",
              format: next.container,
              quality: next.quality,
              completedAt: Date.now(),
            });
            setHistory(loadHistory());
          }
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setPhase("error");
          setError(err.message);
        });
    }, 800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, job, video]);

  async function handleAnalyze(nextUrl: string) {
    setUrl(nextUrl);
    setPhase("analyzing");
    setError(null);
    setJob(null);
    setVideo(null);
    rememberUrl(nextUrl);
    try {
      const result = await analyzeVideo(nextUrl);
      setVideo(result);
      setSelectedId(result.presets[0]?.id || result.formats[0]?.id || "");
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "We couldn't analyze this video.");
      toast.error(err instanceof Error ? err.message : "We couldn't analyze this video.");
    }
  }

  async function handleDownload() {
    if (!video || !selectedId) return;
    setStarting(true);
    setError(null);
    try {
      const created = await startDownload({
        url: video.webpageUrl || url,
        formatId: selectedId,
        title: video.title,
        thumbnail: video.thumbnail,
        source: video.source,
      });
      setJob(created);
      setPhase("processing");
    } catch (err) {
      const message = err instanceof Error ? err.message : "We couldn't process this video.";
      setError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  function reset() {
    setPhase("idle");
    setVideo(null);
    setJob(null);
    setError(null);
    setSelectedId("");
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-20">
      <section className="mb-10 space-y-4 text-center sm:mb-14">
        <p className="text-sm font-medium tracking-wide text-muted-foreground">VideoFetch</p>
        <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">
          Download videos
          <span className="mt-1 block italic text-muted-foreground">in the format you want</span>
        </h1>
        <p className="mx-auto max-w-lg text-base text-muted-foreground">
          Paste a video link, choose your quality, and download.
        </p>
      </section>

      <UrlInput
        value={url}
        onChange={setUrl}
        onSubmit={(next) => void handleAnalyze(next)}
        loading={phase === "analyzing"}
        disabled={phase === "processing"}
      />

      <div className="mt-8 space-y-8">
        {phase === "analyzing" ? (
          <Card>
            <CardContent className="space-y-4 p-5 sm:p-6">
              <p className="text-sm text-muted-foreground">Analyzing video...</p>
              <div className="flex flex-col gap-4 sm:flex-row">
                <Skeleton className="aspect-video w-full rounded-lg sm:w-56" />
                <div className="flex-1 space-y-3">
                  <Skeleton className="h-6 w-4/5" />
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {phase === "error" && error ? (
          <Card>
            <CardContent className="space-y-3 p-5 sm:p-6">
              <h2 className="font-medium">We hit a snag</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
              <button
                type="button"
                className="text-sm underline-offset-4 hover:underline"
                onClick={reset}
              >
                Start over
              </button>
            </CardContent>
          </Card>
        ) : null}

        {video && (phase === "ready" || phase === "processing" || phase === "complete") ? (
          <Card>
            <CardContent className="space-y-6 p-5 sm:p-6">
              <VideoCard video={video} />
              {phase === "ready" ? (
                <FormatSelector
                  video={video}
                  simpleMode={simpleMode}
                  onSimpleMode={setSimpleMode}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onDownload={() => void handleDownload()}
                  downloading={starting}
                />
              ) : null}
              {phase === "processing" && job ? <ProgressCard job={job} /> : null}
              {phase === "complete" && job ? <CompleteCard job={job} onReset={reset} /> : null}
            </CardContent>
          </Card>
        ) : null}

        <DownloadHistory items={history} />
      </div>
    </div>
  );
}
