import { config } from "@/lib/config";
import { AppError, ERROR_MESSAGES, jsonError, type ErrorCode } from "@/lib/errors";
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
  requireConfiguredPrivateAccess,
  requirePrivateAccess,
  serializeAccessCookie,
  serializeClearedAccessCookie,
} from "@/lib/security/private-access.server";
import { GENERIC_YTDLP_EXECUTION_IMPLEMENTED } from "@/shared/capabilities";
import { WORKER_PRIVATE_PRINCIPAL } from "@/shared/worker/constants";
import { WorkerAnalyzeRequestSchema, WorkerJobIdSchema } from "@/shared/worker/contracts";
import {
  getObjectStoreSigner,
  getWorkerClient,
} from "@/web/config/worker-runtime.server";
import { toPublicJob } from "@/web/jobs/public-job";

/**
 * Vercel control plane.
 *
 * This module owns browser authentication, browser-facing validation, rate
 * limiting, initial URL validation, and public DTO adaptation. It performs NO
 * media work: there is no in-process manager, no extractor registry, no
 * yt-dlp, no FFmpeg, no temp filesystem, and no local file streaming. Every
 * media operation crosses the authenticated HMAC boundary to the Worker, and
 * there is no production fallback to the legacy local path.
 */

type SitesOp = () => Promise<unknown>;

let sitesOp: SitesOp = loadSites;

export function setSitesOperationForTests(fn: SitesOp | null): void {
  sitesOp = fn ?? loadSites;
}

export function resetPrivateAccessApiForTests(): void {
  sitesOp = loadSites;
}

/**
 * Capability information comes from authenticated Worker diagnostics plus the
 * static catalog. The control plane deliberately holds no local extractor
 * registry or binary probe of its own.
 */
/**
 * Re-exported from the dependency-free shared module so the browser diagnostics
 * route can state the same compile-time fact without importing this server-only
 * module (which carries the worker client, the object-store signer and the SSRF
 * boundary).
 *
 * It is one of THREE independent conjuncts in `ytdlp` below, and the weakest
 * kind of claim of the three: code existing is not a runtime being installed,
 * and neither is an operator having enabled the feature. Production still runs
 * with `YTDLP_ENABLED` unset as of this change, so `/api/sites.ytdlp` remains
 * false there.
 */
export { GENERIC_YTDLP_EXECUTION_IMPLEMENTED } from "@/shared/capabilities";

async function loadSites() {
  const diagnostics = await getWorkerClient().diagnostics();
  // `ytdlp` answers one question only: can this build actually extract from a
  // generic site right now? Three things must hold — the code path must exist,
  // the pinned runtime must execute, and the operator must have enabled it.
  //
  // All three are still required after Phase 10C3. The constant became true, so
  // the conjunction now genuinely tracks the other two rather than being pinned
  // false by the first — which is exactly why they must stay conjoined: an
  // image without the runtime, or a deployment with YTDLP_ENABLED unset, must
  // still report false.
  const ytdlpInstalled = diagnostics.binaries.ytdlp;
  const ytdlpEnabled = diagnostics.features.ytdlpEnabled;
  return {
    ytdlp: GENERIC_YTDLP_EXECUTION_IMPLEMENTED && ytdlpInstalled && ytdlpEnabled,
    // The two underlying facts stay independently observable, so an operator
    // can distinguish "runtime absent" from "runtime present but switched off"
    // without inferring it from a single collapsed boolean.
    ytdlpInstalled,
    ytdlpEnabled,
    ffmpeg: diagnostics.binaries.ffmpeg,
    sites: SITE_CATALOG,
    note: "Support depends on each website’s delivery method and can change without notice. Direct media files and publicly accessible archive sources are the most reliable.",
  };
}

function jsonNoStore(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return Response.json(body, { status, headers: noStoreHeaders(extra) });
}

/**
 * Browser-facing error responder for every handler that crosses the Worker or
 * object-store boundary.
 *
 * Unlike `jsonError`, this NEVER serializes an AppError's own message: the
 * response always carries the canonical `ERROR_MESSAGES[code]`. A worker or
 * signer failure whose message happens to embed an object key, a bucket, a
 * host, or a stack fragment therefore cannot reach the browser.
 */
function safeJsonError(err: unknown, fallback: ErrorCode): Response {
  const code = err instanceof AppError ? err.code : fallback;
  const status = err instanceof AppError ? err.status : undefined;
  return jsonError(new AppError(code, ERROR_MESSAGES[code], status), fallback);
}

/**
 * Vercel-side initial URL validation, then a fail-closed check that the URL is
 * one the Worker contract can even accept. The Worker validates independently
 * again on its own side.
 */
async function validateBrowserUrl(raw: unknown): Promise<string> {
  const url = typeof raw === "string" ? raw : "";
  const safe = await assertSafeUrl(url);
  const parsed = WorkerAnalyzeRequestSchema.safeParse({ url: safe.url });
  if (!parsed.success) {
    throw new AppError("INVALID_URL");
  }
  return parsed.data.url;
}

function validateJobId(raw: string): string {
  const parsed = WorkerJobIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("NOT_FOUND");
  }
  return parsed.data;
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
    const url = await validateBrowserUrl(body?.url);
    const result = await getWorkerClient().analyze({ url });
    return Response.json({ success: true, video: result.video });
  } catch (err) {
    return safeJsonError(err, "ANALYSIS_FAILED");
  }
}

export async function handleDownload(request: Request): Promise<Response> {
  try {
    const principal = requirePrivateAccess(request);
    if (!consumeRateLimit(`download:${principal.id}`, Math.max(8, Math.floor(config.rateLimitPerMinute / 2)))) {
      throw new AppError("RATE_LIMITED");
    }
    // `title`, `thumbnail` and `source` may still be sent by older clients.
    // They are accepted and ignored: Worker analysis is authoritative for job
    // metadata, so browser-supplied values are never forwarded.
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      formatId?: unknown;
    } | null;
    const formatId = typeof body?.formatId === "string" ? body.formatId : "";
    if (!formatId) throw new AppError("FORMAT_UNAVAILABLE");
    const url = await validateBrowserUrl(body?.url);

    const created = await getWorkerClient().createJob({
      url,
      formatId,
      // Server-derived. The browser can never choose the principal, and the
      // Idempotency-Key is generated inside WorkerClient, never by the browser.
      principalId: WORKER_PRIVATE_PRINCIPAL,
    });

    return Response.json(toPublicJob(created.job, Date.now()));
  } catch (err) {
    return safeJsonError(err, "PROCESSING_FAILED");
  }
}

export async function handleDownloadStatus(request: Request, jobId: string): Promise<Response> {
  try {
    requirePrivateAccess(request);
    const validId = validateJobId(jobId);
    const result = await getWorkerClient().getJob(validId);
    return Response.json(toPublicJob(result.job, Date.now()));
  } catch (err) {
    return safeJsonError(err, "NOT_FOUND");
  }
}

/**
 * Authorized file delivery.
 *
 * Vercel never touches the bytes. It authorizes, confirms the job is ready and
 * unexpired, and redirects to a short-lived object-store GET signature. The
 * signed URL appears ONLY in the Location header: it is never placed in JSON,
 * never persisted, and never logged.
 */
export async function handleDownloadFile(request: Request, jobId: string): Promise<Response> {
  try {
    requirePrivateAccess(request);
    const validId = validateJobId(jobId);
    const { job } = await getWorkerClient().getJob(validId);

    if (job.status !== "ready") {
      throw new AppError("NOT_FOUND");
    }
    if (Date.now() >= job.expiresAt) {
      throw new AppError("EXPIRED");
    }
    // Server-only. Present on this boundary because it is the authenticated
    // Vercel-to-Worker view; it must not travel any further.
    const objectKey = job.objectKey;
    if (!objectKey) {
      throw new AppError("NOT_FOUND");
    }

    const signed = await getObjectStoreSigner().signGet({
      objectKey,
      expiresAt: job.expiresAt,
    });

    return new Response(null, {
      status: 303,
      headers: {
        Location: signed.url,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    return safeJsonError(err, "NOT_FOUND");
  }
}

export async function handleSites(request: Request): Promise<Response> {
  try {
    requirePrivateAccess(request);
    return Response.json(await sitesOp());
  } catch (err) {
    return safeJsonError(err, "ACCESS_REQUIRED");
  }
}

export async function handleDiagnostics(request: Request): Promise<Response> {
  try {
    requireConfiguredPrivateAccess(request);
    const data = await getWorkerClient().diagnostics();
    return jsonNoStore(data);
  } catch (err) {
    return safeJsonError(err, "ACCESS_REQUIRED");
  }
}
