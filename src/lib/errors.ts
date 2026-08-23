export type ErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SITE"
  | "VIDEO_UNAVAILABLE"
  | "ANALYSIS_FAILED"
  | "FORMAT_UNAVAILABLE"
  | "SERVER_OVERLOAD"
  | "PROCESSING_FAILED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "EXTRACTION_FAILED"
  | "EXTRACTOR_UNAVAILABLE"
  | "TOO_LARGE"
  | "TOO_LONG"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "EXPIRED"
  | "FORBIDDEN";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: "Please enter a valid video URL.",
  UNSUPPORTED_SITE: "This website is not currently supported.",
  VIDEO_UNAVAILABLE: "The video could not be accessed or is no longer available.",
  ANALYSIS_FAILED: "We couldn't analyze this video.",
  FORMAT_UNAVAILABLE: "The selected quality is no longer available.",
  SERVER_OVERLOAD:
    "The server is currently processing too many downloads. Please try again shortly.",
  PROCESSING_FAILED: "We couldn't process this video. Try another format or source.",
  TIMEOUT: "The video took too long to process.",
  NETWORK_ERROR: "We couldn't connect to the source website.",
  EXTRACTION_FAILED: "We couldn't extract the video streams from this page.",
  EXTRACTOR_UNAVAILABLE:
    "Generic website extraction is temporarily unavailable on this server.",
  TOO_LARGE: "This video exceeds the maximum supported download size.",
  TOO_LONG: "This video exceeds the maximum supported duration.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  NOT_FOUND: "We couldn't find that download.",
  EXPIRED: "This download link has expired. Please analyze the video again.",
  FORBIDDEN: "Diagnostics are not available in this environment.",
};

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  UNSUPPORTED_SITE: 422,
  VIDEO_UNAVAILABLE: 404,
  ANALYSIS_FAILED: 502,
  FORMAT_UNAVAILABLE: 409,
  SERVER_OVERLOAD: 429,
  PROCESSING_FAILED: 500,
  TIMEOUT: 504,
  NETWORK_ERROR: 502,
  EXTRACTION_FAILED: 502,
  EXTRACTOR_UNAVAILABLE: 503,
  TOO_LARGE: 413,
  TOO_LONG: 413,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  EXPIRED: 410,
  FORBIDDEN: 403,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, status?: number) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
  }
}

export function jsonError(error: AppError | Error, fallback: ErrorCode = "ANALYSIS_FAILED") {
  if (error instanceof AppError) {
    return Response.json(
      { success: false, error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return Response.json(
    { success: false, error: { code: fallback, message: ERROR_MESSAGES[fallback] } },
    { status: STATUS_BY_CODE[fallback] },
  );
}

export function mapExtractorMessage(raw: string): AppError {
  const text = raw.toLowerCase();
  if (text.includes("unsupported url") || text.includes("no video formats")) {
    return new AppError("UNSUPPORTED_SITE");
  }
  if (
    text.includes("sign in") ||
    text.includes("not a bot") ||
    text.includes("login required") ||
    text.includes("only works when logged-in") ||
    text.includes("private video") ||
    text.includes("unavailable") ||
    text.includes("removed") ||
    text.includes("copyright") ||
    text.includes("cookies")
  ) {
    return new AppError(
      "VIDEO_UNAVAILABLE",
      "The video could not be accessed or is no longer available.",
    );
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return new AppError("TIMEOUT");
  }
  if (
    text.includes("connection") ||
    text.includes("network") ||
    text.includes("name or service not known") ||
    text.includes("temporary failure in name resolution")
  ) {
    return new AppError("NETWORK_ERROR");
  }
  if (text.includes("max filesize") || text.includes("file is larger")) {
    return new AppError("TOO_LARGE");
  }
  return new AppError("EXTRACTION_FAILED");
}
