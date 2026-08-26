import type { AnalyzeSuccess, ApiErrorBody, VideoMetadata } from "@/types/media";
import type { JobProgress } from "@/types/job";

export type AccessSession = {
  authenticated: boolean;
  configured: boolean;
  developmentBypass: boolean;
};

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message || "Something went wrong.";
  } catch {
    return "Something went wrong.";
  }
}

export async function getAccessSession(): Promise<AccessSession> {
  const res = await fetch("/api/access/session", { credentials: "same-origin" });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AccessSession;
}

export async function loginWithAccessSecret(secret: string): Promise<AccessSession> {
  const res = await fetch("/api/access/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return getAccessSession();
}

export async function logoutAccess(): Promise<AccessSession> {
  const res = await fetch("/api/access/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(await readError(res));
  return getAccessSession();
}

export async function analyzeVideo(url: string): Promise<VideoMetadata> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as AnalyzeSuccess;
  if (!data.success) throw new Error("We couldn't analyze this video.");
  return data.video;
}

export async function startDownload(input: {
  url: string;
  formatId: string;
  title?: string | null;
  thumbnail?: string | null;
  source?: string | null;
}): Promise<{ jobId: string } & JobProgress> {
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { jobId: string } & JobProgress;
}

export async function getJobStatus(jobId: string): Promise<JobProgress & { jobId: string }> {
  const res = await fetch(`/api/download/${jobId}/status`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as JobProgress & { jobId: string };
}

export type HistoryItem = {
  jobId: string;
  title: string;
  thumbnail: string | null;
  status: string;
  format: string | null;
  quality: string | null;
  completedAt: number;
};

const HISTORY_KEY = "videofetch:history";
const RECENT_KEY = "videofetch:recent-urls";

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function saveHistoryItem(item: HistoryItem) {
  const next = [item, ...loadHistory().filter((h) => h.jobId !== item.jobId)].slice(0, 8);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function loadRecentUrls(): string[] {
  try {
    const raw = sessionStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberUrl(url: string) {
  const next = [url, ...loadRecentUrls().filter((u) => u !== url)].slice(0, 5);
  try {
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}
