import type { IncomingMessage } from "node:http";
import { Buffer } from "node:buffer";
import { WORKER_CONTROL_MAX_BODY_BYTES } from "../../shared/worker/constants.ts";

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload Too Large");
    this.name = "PayloadTooLargeError";
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super("Unsupported Media Type");
    this.name = "UnsupportedMediaTypeError";
  }
}

export class MalformedContentLengthError extends Error {
  constructor() {
    super("Malformed Content-Length");
    this.name = "MalformedContentLengthError";
  }
}

/**
 * Reads the exact bounded raw bytes from the HTTP request.
 * Enforces `WORKER_CONTROL_MAX_BODY_BYTES`.
 *
 * Drain policy: when the body is known-overlimit (Content-Length) or discovered
 * overlimit during streaming, the remainder is discarded via `req.resume()` so
 * a keep-alive connection is not left with an unread request body.
 */
export async function readBoundedRawBody(req: IncomingMessage): Promise<Buffer> {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      req.resume(); // drain
      throw new MalformedContentLengthError();
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) {
      req.resume(); // drain
      throw new MalformedContentLengthError();
    }
    if (length > WORKER_CONTROL_MAX_BODY_BYTES) {
      req.resume(); // drain
      throw new PayloadTooLargeError();
    }
  }

  const contentEncoding = req.headers["content-encoding"];
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    req.resume(); // drain
    throw new UnsupportedMediaTypeError();
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > WORKER_CONTROL_MAX_BODY_BYTES) {
        cleanup();
        req.resume(); // drain remainder without buffering
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
