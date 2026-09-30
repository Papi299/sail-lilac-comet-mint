import { useEffect, useReducer, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { UrlInput } from "@/components/video/url-input";
import { VideoCard } from "@/components/video/video-card";
import { FormatSelector } from "@/components/video/format-selector";
import { NoCompatibleDownload } from "@/components/video/no-compatible-download";
import { ProgressCard } from "@/components/video/progress-card";
import { CompleteCard } from "@/components/video/complete-card";
import { DownloadHistory } from "@/components/video/history";
import { PrivateAccessGate } from "@/components/video/private-access-gate";
import { ErrorCard } from "@/components/video/error-card";
import { StatusConnectionNotice } from "@/components/video/status-connection-notice";
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
import { hasDownloadOptions, initialSelectionId } from "@/lib/download-options";
import {
  downloaderReducer,
  finishedJobForHistory,
  historyEntryForJob,
  initialDownloaderState,
  startStatusPollSession,
  statusPollTarget,
} from "@/lib/downloader-state";
import { errorCardHeading } from "@/lib/job-failure-ui";
import type { VideoMetadata } from "@/types/media";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <PrivateAccessGate>
      <Downloader />
    </PrivateAccessGate>
  );
}

function Downloader() {
  const [url, setUrl] = useState("");
  const [state, dispatch] = useReducer(downloaderReducer, initialDownloaderState);
  const { phase, job, error, connectivity } = state;
  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [simpleMode, setSimpleMode] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [starting, setStarting] = useState(false);
  const videoRef = useRef<VideoMetadata | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    videoRef.current = video;
  }, [video]);

  // One single-flight polling loop per session. The session changes only when
  // a new job starts or the person asks to retry the status, so progress
  // updates never restart the loop; reset, a new job and unmount all stop it.
  // A transient failure keeps the job in `processing` (see downloader-state).
  const pollTarget = statusPollTarget(state);
  const pollJobId = pollTarget?.jobId ?? null;
  const pollSession = pollTarget?.session ?? null;
  useEffect(() => {
    if (!pollJobId || !pollSession) return;
    const poller = startStatusPollSession(
      { jobId: pollJobId, session: pollSession },
      dispatch,
      (id, signal) => getJobStatus(id, { signal }),
    );
    return () => poller.stop();
  }, [pollJobId, pollSession]);

  // History records how a job ended — `ready`, `failed` or `cancelled` — and is
  // derived from accepted state, never from a lost connection.
  const finishedJob = finishedJobForHistory(state);
  useEffect(() => {
    if (!finishedJob) return;
    saveHistoryItem(historyEntryForJob(finishedJob, videoRef.current, Date.now()));
    setHistory(loadHistory());
  }, [finishedJob]);

  async function handleAnalyze(nextUrl: string) {
    setUrl(nextUrl);
    dispatch({ type: "analyze_started" });
    setVideo(null);
    rememberUrl(nextUrl);
    try {
      const result = await analyzeVideo(nextUrl);
      setVideo(result);
      setSelectedId(initialSelectionId(result));
      dispatch({ type: "analyze_succeeded" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "We couldn't analyze this video.";
      dispatch({ type: "analyze_failed", message });
      toast.error(message);
    }
  }

  async function handleDownload() {
    if (!video || !selectedId) return;
    setStarting(true);
    dispatch({ type: "download_requested" });
    try {
      const created = await startDownload({
        url: video.webpageUrl || url,
        formatId: selectedId,
        title: video.title,
        thumbnail: video.thumbnail,
        source: video.source,
      });
      dispatch({ type: "download_started", job: created });
    } catch (err) {
      const message = err instanceof Error ? err.message : "We couldn't process this video.";
      dispatch({ type: "download_failed", message });
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  function reset() {
    dispatch({ type: "reset" });
    setVideo(null);
    setSelectedId("");
  }

  function retryStatus() {
    dispatch({ type: "retry_status" });
  }

  // Unlike `reset`, clears the URL: analyzing the same link again would yield
  // the same result.
  function tryAnotherUrl() {
    setUrl("");
    reset();
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
          // Only a FAILED job's closed stage label can change the heading; an
          // analysis error or a definitive status answer (NOT_FOUND, EXPIRED,
          // an access failure) has no job stage and keeps the generic one. A
          // transient status failure never reaches this card.
          <ErrorCard heading={errorCardHeading(job)} message={error} onReset={reset} />
        ) : null}

        {video && (phase === "ready" || phase === "processing" || phase === "complete") ? (
          <Card>
            <CardContent className="space-y-6 p-5 sm:p-6">
              <VideoCard video={video} />
              {phase === "ready" ? (
                hasDownloadOptions(video) ? (
                  <FormatSelector
                    video={video}
                    simpleMode={simpleMode}
                    onSimpleMode={setSimpleMode}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onDownload={() => void handleDownload()}
                    downloading={starting}
                  />
                ) : (
                  <NoCompatibleDownload
                    sourceQuality={video.sourceQuality}
                    onTryAnother={tryAnotherUrl}
                  />
                )
              ) : null}
              {phase === "processing" && job ? (
                <>
                  <ProgressCard job={job} />
                  <StatusConnectionNotice
                    connectivity={connectivity}
                    onRetryStatus={retryStatus}
                    onReset={reset}
                  />
                </>
              ) : null}
              {phase === "complete" && job ? <CompleteCard job={job} onReset={reset} /> : null}
            </CardContent>
          </Card>
        ) : null}

        <DownloadHistory items={history} />
      </div>
    </div>
  );
}
