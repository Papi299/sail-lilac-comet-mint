import { ERROR_MESSAGES, type ErrorCode } from "@/lib/errors";
import type { AnalyzeSuccess, VideoMetadata } from "@/types/media";
import type { JobProgress } from "@/types/job";

export type AccessSession = {
  authenticated: boolean;
  configured: boolean;
  developmentBypass: boolean;
};

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: a failed control-plane call, as the
 * browser may act on it.
 *
 * It carries structure only — whether a response existed at all, its HTTP
 * status, and its code once that code has passed the closed `ErrorCode`
 * allowlist — so retry decisions never depend on message text. It never holds
 * the raw body, the URL, headers, or the underlying browser exception, and
 * `message` is always safe to show.
 */
export type ClientApiFailureKind = "response" | "network";

export const GENERIC_API_ERROR_MESSAGE = "Something went wrong.";

/** Application-owned copy for a request that never produced a response. */
export const NETWORK_API_ERROR_MESSAGE =
  "We couldn't reach VideoFetch. Check your connection and try again.";

export class ClientApiError extends Error {
  readonly kind: ClientApiFailureKind;
  /** Allowlisted canonical code, or null when the response carried none. */
  readonly code: ErrorCode | null;
  /** HTTP status of the response; null when no response was received. */
  readonly status: number | null;

  constructor(input: {
    kind: ClientApiFailureKind;
    code: ErrorCode | null;
    status: number | null;
    message: string;
  }) {
    super(input.message);
    this.name = "ClientApiError";
    this.kind = input.kind;
    this.code = input.code;
    this.status = input.status;
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_MESSAGES, value);
}

function networkError(): ClientApiError {
  return new ClientApiError({
    kind: "network",
    code: null,
    status: null,
    message: NETWORK_API_ERROR_MESSAGE,
  });
}

/**
 * The only path to the network. A rejected `fetch` — offline, DNS, reset,
 * abort — has no response to classify, so it becomes a `network` failure and
 * the browser's own wording ("Failed to fetch", "Load failed") is dropped.
 */
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw networkError();
  }
}

/**
 * Reads a non-2xx response against the canonical `{ success: false, error: {
 * code, message } }` envelope. The code must be one of the application's own;
 * anything else — a malformed body, an HTML error page, an unknown or
 * differently-cased code — keeps only the HTTP status and the generic message,
 * so no part of an unrecognized body can reach the page.
 *
 * A recognized envelope keeps its message: the control plane is same-origin
 * and writes these messages itself, and every handler that crosses the Worker
 * or object-store boundary already canonicalizes them before they leave.
 */
async function responseError(res: Response): Promise<ClientApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Unreadable or not JSON: nothing in it is trusted.
  }
  const error =
    body !== null && typeof body === "object" && (body as { success?: unknown }).success === false
      ? (body as { error?: unknown }).error
      : null;
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : null;
  if (!isErrorCode(code)) {
    return new ClientApiError({
      kind: "response",
      code: null,
      status: res.status,
      message: GENERIC_API_ERROR_MESSAGE,
    });
  }
  const message = (error as { message?: unknown }).message;
  return new ClientApiError({
    kind: "response",
    code,
    status: res.status,
    message: typeof message === "string" && message.length > 0 ? message : ERROR_MESSAGES[code],
  });
}

export async function getAccessSession(): Promise<AccessSession> {
  const res = await apiFetch("/api/access/session", { credentials: "same-origin" });
  if (!res.ok) throw await responseError(res);
  return (await res.json()) as AccessSession;
}

export async function loginWithAccessSecret(secret: string): Promise<AccessSession> {
  const res = await apiFetch("/api/access/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) throw await responseError(res);
  return getAccessSession();
}

export async function logoutAccess(): Promise<AccessSession> {
  const res = await apiFetch("/api/access/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) throw await responseError(res);
  return getAccessSession();
}

export async function analyzeVideo(url: string): Promise<VideoMetadata> {
  const res = await apiFetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw await responseError(res);
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
  const res = await apiFetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await responseError(res);
  return (await res.json()) as { jobId: string } & JobProgress;
}

export type PolledJob = JobProgress & { jobId: string };

/**
 * One status read. Every failure is a `ClientApiError`, including a body that
 * breaks off mid-read (`network`) and a 2xx whose body is not this job's status
 * (`response`, code null) — for example an interstitial page served by
 * something between the browser and the control plane.
 */
export async function getJobStatus(
  jobId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PolledJob> {
  const res = await apiFetch(`/api/download/${jobId}/status`, { signal: options.signal });
  if (!res.ok) throw await responseError(res);
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw networkError();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (
    body === null ||
    typeof body !== "object" ||
    (body as { jobId?: unknown }).jobId !== jobId ||
    typeof (body as { status?: unknown }).status !== "string"
  ) {
    throw new ClientApiError({
      kind: "response",
      code: null,
      status: res.status,
      message: GENERIC_API_ERROR_MESSAGE,
    });
  }
  return body as PolledJob;
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
