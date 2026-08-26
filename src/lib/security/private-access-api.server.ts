import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { config, isProd } from "@/lib/config";
import { AppError, jsonError } from "@/lib/errors";
import { SITE_CATALOG } from "@/lib/sites-catalog";
import { consumeRateLimit } from "@/lib/security/rate-limit.server";
import { assertSafeUrl } from "@/lib/security/ssrf.server";
import {
  ACCESS_LOGIN_RATE_KEY,
  ACCESS_LOGIN_RATE_LIMIT,
  assertPrivateAccessIsolation,
  authenticateAccessSecret,
  describeAccessSession,
  noStoreHeaders,
  requirePrivateAccess,
  serializeAccessCookie,
  serializeClearedAccessCookie,
} from "@/lib/security/private-access.server";
import {
  analyzeVideo as analyzeVideoImpl,
  diagnosticsSnapshot as diagnosticsSnapshotImpl,
  enqueueDownload as enqueueDownloadImpl,
  getJobOrThrow as getJobOrThrowImpl,
  getPublicJob as getPublicJobImpl,
} from "@/services/downloads/manager.server";
import { listExtractors } from "@/services/extractors/registry.server";
import { ytdlpAvailable } from "@/services/extractors/ytdlp.server";
import { ffmpegAvailable } from "@/services/processing/ffmpeg.server";

type AnalyzeOp = typeof analyzeVideoImpl;
type EnqueueOp = typeof enqueueDownloadImpl;
type PublicJobOp = typeof getPublicJobImpl;
type JobOrThrowOp = typeof getJobOrThrowImpl;
type DiagnosticsOp = typeof diagnosticsSnapshotImpl;
type SitesOp = () => Promise<unknown>;

let analyzeOp: AnalyzeOp = analyzeVideoImpl;
let enqueueOp: EnqueueOp = enqueueDownloadImpl;
let publicJobOp: PublicJobOp = getPublicJobImpl;
let jobOrThrowOp: JobOrThrowOp = getJobOrThrowImpl;
let diagnosticsOp: DiagnosticsOp = diagnosticsSnapshotImpl;
let sitesOp: SitesOp = loadSites;

export function setAnalyzeOperationForTests(fn: AnalyzeOp | null): void {
  analyzeOp = fn ?? analyzeVideoImpl;
}

export function setEnqueueOperationForTests(fn: EnqueueOp | null): void {
  enqueueOp = fn ?? enqueueDownloadImpl;
}

export function setPublicJobOperationForTests(fn: PublicJobOp | null): void {
  publicJobOp = fn ?? getPublicJobImpl;
}

export function setJobOrThrowOperationForTests(fn: JobOrThrowOp | null): void {
  jobOrThrowOp = fn ?? getJobOrThrowImpl;
}

export function setDiagnosticsOperationForTests(fn: DiagnosticsOp | null): void {
  diagnosticsOp = fn ?? diagnosticsSnapshotImpl;
}

export function setSitesOperationForTests(fn: SitesOp | null): void {
  sitesOp = fn ?? loadSites;
}

export function resetPrivateAccessApiForTests(): void {
  analyzeOp = analyzeVideoImpl;
  enqueueOp = enqueueDownloadImpl;
  publicJobOp = getPublicJobImpl;
  jobOrThrowOp = getJobOrThrowImpl;
  diagnosticsOp = diagnosticsSnapshotImpl;
  sitesOp = loadSites;
}

async function loadSites() {
  const [ytdlp, ffmpeg] = await Promise.all([ytdlpAvailable(), ffmpegAvailable()]);
  return {
    extractors: listExtractors(),
    ytdlp,
    ffmpeg,
    sites: SITE_CATALOG,
    note: "Support depends on each website’s delivery method and can change without notice. Direct media files and publicly accessible archive sources are the most reliable.",
  };
}

function jsonNoStore(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return Response.json(body, { status, headers: noStoreHeaders(extra) });
}

export async function handleAccessSession(request: Request): Promise<Response> {
  try {
    const session = describeAccessSession(request);
    return jsonNoStore(session);
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("session"), "FORBIDDEN");
  }
}

export async function handleAccessLogin(request: Request): Promise<Response> {
  try {
    assertPrivateAccessIsolation(request);
    if (!consumeRateLimit(ACCESS_LOGIN_RATE_KEY, ACCESS_LOGIN_RATE_LIMIT)) {
      throw new AppError("RATE_LIMITED");
    }
    const body = (await request.json().catch(() => null)) as { secret?: unknown } | null;
    const secret = typeof body?.secret === "string" ? body.secret : "";
    const token = authenticateAccessSecret(secret);
    return jsonNoStore(
      { success: true, authenticated: true },
      200,
      { "Set-Cookie": serializeAccessCookie(token) },
    );
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("login"), "ACCESS_REQUIRED");
  }
}

export async function handleAccessLogout(request: Request): Promise<Response> {
  try {
    assertPrivateAccessIsolation(request);
    return jsonNoStore(
      { success: true, authenticated: false },
      200,
      { "Set-Cookie": serializeClearedAccessCookie() },
    );
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("logout"), "FORBIDDEN");
  }
}

export async function handleAnalyze(request: Request): Promise<Response> {
  try {
    const principal = requirePrivateAccess(request);
    if (!consumeRateLimit(`analyze:${principal.id}`, config.rateLimitPerMinute)) {
      throw new AppError("RATE_LIMITED");
    }
    const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    const safe = await assertSafeUrl(url);
    const video = await analyzeOp(safe.url);
    return Response.json({ success: true, video });
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("analyze"), "ANALYSIS_FAILED");
  }
}

export async function handleDownload(request: Request): Promise<Response> {
  try {
    const principal = requirePrivateAccess(request);
    if (!consumeRateLimit(`download:${principal.id}`, Math.max(8, Math.floor(config.rateLimitPerMinute / 2)))) {
      throw new AppError("RATE_LIMITED");
    }
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      formatId?: unknown;
      title?: unknown;
      thumbnail?: unknown;
      source?: unknown;
    } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    const formatId = typeof body?.formatId === "string" ? body.formatId : "";
    if (!formatId) throw new AppError("FORMAT_UNAVAILABLE");
    const safe = await assertSafeUrl(url);
    const job = await enqueueOp({
      url: safe.url,
      formatId,
      principalId: principal.id,
      title: typeof body?.title === "string" ? body.title : null,
      thumbnail: typeof body?.thumbnail === "string" ? body.thumbnail : null,
      source: typeof body?.source === "string" ? body.source : null,
    });
    return Response.json(job);
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("download"), "PROCESSING_FAILED");
  }
}

export async function handleDownloadStatus(request: Request, jobId: string): Promise<Response> {
  try {
    requirePrivateAccess(request);
    const job = publicJobOp(jobId);
    if (!job) throw new AppError("NOT_FOUND");
    return Response.json(job);
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("status"), "NOT_FOUND");
  }
}

export async function handleDownloadFile(request: Request, jobId: string): Promise<Response> {
  try {
    requirePrivateAccess(request);
    const job = jobOrThrowOp(jobId);
    if (job.status !== "ready" || !job.outputPath) {
      throw new AppError("NOT_FOUND");
    }
    const fileStat = await stat(job.outputPath);
    const stream = Readable.toWeb(createReadStream(job.outputPath)) as ReadableStream<Uint8Array>;
    const filename = (job.filename || "video.bin").replace(/"/g, "");
    return new Response(stream, {
      headers: {
        "Content-Type": job.outputMime || "application/octet-stream",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("file"), "NOT_FOUND");
  }
}

export async function handleSites(request: Request): Promise<Response> {
  try {
    requirePrivateAccess(request);
    return Response.json(await sitesOp());
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("sites"), "ACCESS_REQUIRED");
  }
}

function diagnosticsTokenAllowed(request: Request): boolean {
  if (!isProd()) return true;
  const token = config.diagnosticsToken;
  if (!token) return false;
  return request.headers.get("x-diagnostics-token") === token;
}

export async function handleDiagnostics(request: Request): Promise<Response> {
  try {
    requirePrivateAccess(request);
    if (!diagnosticsTokenAllowed(request)) throw new AppError("FORBIDDEN");
    const data = await diagnosticsOp();
    return Response.json(data);
  } catch (err) {
    return jsonError(err instanceof Error ? err : new Error("diagnostics"), "FORBIDDEN");
  }
}
