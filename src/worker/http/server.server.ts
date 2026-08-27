import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Buffer } from "node:buffer";
import { readBoundedRawBody, PayloadTooLargeError, UnsupportedMediaTypeError, MalformedContentLengthError } from "./body.server.ts";
import { WorkerAuthenticator, WorkerAuthenticationError, WorkerReplayStoreUnavailableError, type WorkerAuthConfig } from "../security/authenticate.server.ts";
import {
  WORKER_ANALYZE_PATH,
  WORKER_JOBS_PATH,
  WORKER_DIAGNOSTICS_PATH,
  WORKER_HEALTH_PATH,
} from "../../shared/worker/constants.ts";
import { WorkerAnalyzeRequestSchema, WorkerCreateJobRequestSchema, WorkerJobIdSchema } from "../../shared/worker/contracts.ts";
import { WorkerIdempotencyKeySchema } from "../../shared/worker/auth.ts";

function sendJson(res: ServerResponse, statusCode: number, payload: any) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res: ServerResponse, statusCode: number, message: string = "error") {
  sendJson(res, statusCode, { error: message });
}

function sendUnauthorized(res: ServerResponse) {
  sendError(res, 401, "unauthorized");
}

function getHeaderStrict(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (Array.isArray(val)) {
    throw new Error("duplicate header");
  }
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name.toLowerCase()) {
      count++;
    }
  }
  if (count > 1) {
    throw new Error("duplicate header");
  }
  return val;
}

type RouteCategory = "health" | "analyze" | "jobs_create" | "jobs_get" | "jobs_cancel" | "diagnostics";

interface ParsedRoute {
  category: RouteCategory;
  jobId: string | null;
}

function parseWorkerRoute(rawTarget: string, method: string): ParsedRoute | { error: number; message: string } {
  if (rawTarget === WORKER_HEALTH_PATH) {
    if (method !== "GET") return { error: 405, message: "Method Not Allowed" };
    return { category: "health", jobId: null };
  }
  if (rawTarget === WORKER_ANALYZE_PATH) {
    if (method !== "POST") return { error: 405, message: "Method Not Allowed" };
    return { category: "analyze", jobId: null };
  }
  if (rawTarget === WORKER_JOBS_PATH) {
    if (method !== "POST") return { error: 405, message: "Method Not Allowed" };
    return { category: "jobs_create", jobId: null };
  }
  if (rawTarget === WORKER_DIAGNOSTICS_PATH) {
    if (method !== "GET") return { error: 405, message: "Method Not Allowed" };
    return { category: "diagnostics", jobId: null };
  }
  if (rawTarget.startsWith(WORKER_JOBS_PATH + "/")) {
    const remainder = rawTarget.substring(WORKER_JOBS_PATH.length + 1);

    // /v1/jobs/<id> — use authoritative Phase-1 schema
    const statusParse = WorkerJobIdSchema.safeParse(remainder);
    if (statusParse.success) {
      if (method !== "GET") return { error: 405, message: "Method Not Allowed" };
      return { category: "jobs_get", jobId: statusParse.data };
    }

    // /v1/jobs/<id>/cancel — extract candidate, validate with schema
    const slashIdx = remainder.indexOf("/");
    if (slashIdx > 0 && remainder.substring(slashIdx) === "/cancel") {
      const candidate = remainder.substring(0, slashIdx);
      const cancelParse = WorkerJobIdSchema.safeParse(candidate);
      if (cancelParse.success) {
        if (method !== "POST") return { error: 405, message: "Method Not Allowed" };
        return { category: "jobs_cancel", jobId: cancelParse.data };
      }
    }
  }

  return { error: 404, message: "Not Found" };
}

export function createWorkerServer(authConfig: WorkerAuthConfig): Server {
  const authenticator = new WorkerAuthenticator(authConfig);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!req.url) {
        return sendError(res, 400, "Bad Request");
      }

      // 1. Exact raw METHOD + PATH matching
      const routeResult = parseWorkerRoute(req.url, req.method || "GET");
      if ("error" in routeResult) {
        return sendError(res, routeResult.error, routeResult.message);
      }
      const routeCategory = routeResult.category;
      
      // Unauthenticated health route
      if (routeCategory === "health") {
        return sendJson(res, 200, { status: "ok" });
      }

      // 2. Body Read
      let rawBody: Buffer;
      try {
        rawBody = await readBoundedRawBody(req);
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) {
          return sendError(res, 413, "Payload Too Large");
        } else if (err instanceof UnsupportedMediaTypeError) {
          return sendError(res, 415, "Unsupported Media Type");
        } else if (err instanceof MalformedContentLengthError) {
          return sendError(res, 400, "Bad Request");
        }
        return sendError(res, 400, "Bad Request");
      }

      // 3. Header parsing & duplicate check
      let keyId, timestamp, requestId, signature, idempotencyKey;
      try {
        keyId = getHeaderStrict(req, "x-videofetch-key-id");
        timestamp = getHeaderStrict(req, "x-videofetch-timestamp");
        requestId = getHeaderStrict(req, "x-videofetch-request-id");
        signature = getHeaderStrict(req, "x-videofetch-signature");
        idempotencyKey = getHeaderStrict(req, "idempotency-key");
      } catch {
        return sendUnauthorized(res);
      }

      if (!keyId || !timestamp || !requestId || !signature) {
        return sendUnauthorized(res);
      }

      // 4. Authenticate & Reserve Replay
      try {
        await authenticator.authenticateAndReserve({
          keyId,
          method: (req.method || "GET") as "GET" | "POST",
          canonicalPath: req.url, // rawTarget === canonicalPath
          timestampSeconds: timestamp,
          requestId,
          idempotencyKey,
          rawBody,
          signatureHex: signature,
        });
      } catch (err: any) {
        if (err instanceof WorkerAuthenticationError) {
          return sendUnauthorized(res);
        } else if (err instanceof WorkerReplayStoreUnavailableError) {
          return sendError(res, 503, "Service Unavailable");
        }
        // Fallback for unexpected failures (e.g., storage down)
        return sendError(res, 503, "Service Unavailable");
      }

      // 5. Post-Auth Routing & Body Validation
      if (routeCategory === "jobs_create") {
        if (!idempotencyKey) {
          return sendError(res, 400, "Bad Request");
        }
        const idempotencyParse = WorkerIdempotencyKeySchema.safeParse(idempotencyKey);
        if (!idempotencyParse.success) {
          return sendError(res, 400, "Bad Request");
        }
      } else {
        if (idempotencyKey) {
          return sendError(res, 400, "Bad Request");
        }
      }

      const contentType = req.headers["content-type"]?.split(";")[0]?.trim();
      const requiresJson = routeCategory === "analyze" || routeCategory === "jobs_create";

      if (requiresJson) {
        if (contentType !== "application/json") {
          return sendError(res, 415, "Unsupported Media Type");
        }
        let parsedJson: any;
        try {
          parsedJson = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return sendError(res, 400, "Bad Request");
        }

        if (routeCategory === "analyze") {
          const resParse = WorkerAnalyzeRequestSchema.safeParse(parsedJson);
          if (!resParse.success) {
            return sendError(res, 400, "Bad Request");
          }
        } else if (routeCategory === "jobs_create") {
          const resParse = WorkerCreateJobRequestSchema.safeParse(parsedJson);
          if (!resParse.success) {
            return sendError(res, 400, "Bad Request");
          }
        }
      } else {
        if (rawBody.length > 0) {
          return sendError(res, 400, "Bad Request");
        }
      }

      // 6. Temporary Business Placeholders
      return sendError(res, 501, "Not Implemented");

    } catch {
      return sendError(res, 500, "Internal Server Error");
    }
  });
}
