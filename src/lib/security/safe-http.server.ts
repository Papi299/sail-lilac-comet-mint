import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import { Readable } from "node:stream";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { isIpv4, isPrivateIp, validatePublicHttpUrl } from "@/lib/validation/url";

export type DnsAnswer = { address: string; family: 4 | 6 };

export type LookupFn = (hostname: string) => Promise<DnsAnswer[]>;

export type SafeRequestOnce = (args: {
  url: URL;
  method: "GET" | "HEAD";
  pinned: DnsAnswer;
  headers: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}) => Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage | Readable | null;
}>;

export type SafeHttpRequestOptions = {
  url: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
};

export type SafeHttpResponse = {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage | Readable | null;
};

export type PinnedRequestOptions = RequestOptions & {
  agent: false;
  servername: string;
  lookup: NonNullable<RequestOptions["lookup"]>;
  family: 4 | 6;
};

export type NodeRequestFactory = (
  options: PinnedRequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

let lookupImpl: LookupFn = defaultLookup;
let requestOnceImpl: SafeRequestOnce = nodeRequestOnce;
let httpRequestImpl: NodeRequestFactory = http.request.bind(http) as NodeRequestFactory;
let httpsRequestImpl: NodeRequestFactory = https.request.bind(https) as NodeRequestFactory;

export function setSafeHttpTestHooks(
  hooks: { lookup?: LookupFn; requestOnce?: SafeRequestOnce } | null,
): void {
  lookupImpl = hooks?.lookup ?? defaultLookup;
  requestOnceImpl = hooks?.requestOnce ?? nodeRequestOnce;
}

export function setPinnedRequestFactoryForTests(
  factory: { http?: NodeRequestFactory; https?: NodeRequestFactory } | null,
): void {
  httpRequestImpl = factory?.http ?? (http.request.bind(http) as NodeRequestFactory);
  httpsRequestImpl = factory?.https ?? (https.request.bind(https) as NodeRequestFactory);
}

export async function lookupHost(hostname: string): Promise<DnsAnswer[]> {
  return lookupImpl(hostname);
}

export async function defaultLookup(hostname: string): Promise<DnsAnswer[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIpv4(host)) return [{ address: host, family: 4 }];
  if (host.includes(":")) return [{ address: host, family: 6 }];
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map((row) => ({
    address: row.address,
    family: row.family === 6 ? 6 : 4,
  }));
}

export async function validateResolvedAddresses(
  _hostname: string,
  answers: DnsAnswer[],
): Promise<DnsAnswer> {
  if (!answers.length) throw new AppError("NETWORK_ERROR");
  for (const answer of answers) {
    if (isPrivateIp(answer.address)) {
      throw new AppError("INVALID_URL");
    }
  }
  const pinned = answers[0];
  if (!pinned) throw new AppError("NETWORK_ERROR");
  return pinned;
}

/**
 * Parse, policy-check, resolve, and pin a destination.
 * Rejects if ANY resolved address is private (existing conservative policy).
 */
export async function resolveSafeDestination(raw: string): Promise<{
  url: URL;
  hostname: string;
  pinned: DnsAnswer;
  answers: DnsAnswer[];
}> {
  const checked = validatePublicHttpUrl(raw);
  if (!checked.ok) throw new AppError("INVALID_URL", checked.message);
  if (checked.hostname === "sample") {
    throw new AppError("INVALID_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(checked.url);
  } catch {
    throw new AppError("INVALID_URL");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let answers: DnsAnswer[];
  try {
    answers = await lookupImpl(hostname);
  } catch {
    throw new AppError("NETWORK_ERROR");
  }
  const pinned = await validateResolvedAddresses(hostname, answers);
  return { url: parsed, hostname, pinned, answers };
}

function familyOf(address: string, family?: number): 4 | 6 {
  if (family === 6 || family === 4) return family;
  return address.includes(":") ? 6 : 4;
}

function pinnedLookup(
  pinned: DnsAnswer,
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    const cb =
      typeof options === "function"
        ? (options as (err: Error | null, address: unknown, family?: number) => void)
        : callback;
    if (!cb) return;
    const opts = typeof options === "object" && options ? (options as { all?: boolean }) : {};
    const family = familyOf(pinned.address, pinned.family);
    if (opts.all) {
      cb(null, [{ address: pinned.address, family }]);
      return;
    }
    cb(null, pinned.address, family);
  };
}

/**
 * Options for the real Node HTTP(S) request.
 *
 * `agent: false` forces a one-shot Agent so socket reuse cannot skip the
 * newly supplied pinned lookup for this request.
 */
export function buildPinnedRequestOptions(args: {
  url: URL;
  method: "GET" | "HEAD";
  pinned: DnsAnswer;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): PinnedRequestOptions {
  const { url, method, pinned, headers, signal } = args;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return {
    protocol: url.protocol,
    hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: {
      ...headers,
      host: url.host,
    },
    servername: hostname,
    lookup: pinnedLookup(pinned),
    family: familyOf(pinned.address, pinned.family),
    agent: false,
    signal,
  };
}

function nodeRequestOnce(args: {
  url: URL;
  method: "GET" | "HEAD";
  pinned: DnsAnswer;
  headers: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage | null;
}> {
  const { url, method, pinned, headers, signal, timeoutMs } = args;
  const request = url.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
  const options = buildPinnedRequestOptions({ url, method, pinned, headers, signal });

  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: method === "HEAD" ? drainAndNull(res) : res,
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new AppError("TIMEOUT"));
    });
    req.on("error", (err) => {
      if (err instanceof AppError) reject(err);
      else reject(new AppError("NETWORK_ERROR"));
    });
    req.end();
  });
}

function drainAndNull(res: IncomingMessage): null {
  res.resume();
  return null;
}

export function disposeHttpBody(body: IncomingMessage | Readable | null | undefined): void {
  if (!body) return;
  const stream = body as Readable;
  if (typeof stream.destroy === "function") {
    stream.destroy();
    return;
  }
  if (typeof stream.resume === "function") {
    stream.resume();
  }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export async function safeHttpRequest(opts: SafeHttpRequestOptions): Promise<SafeHttpResponse> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? config.analysisTimeoutMs;
  const maxRedirects = opts.maxRedirects ?? config.maxRedirects;
  const userHeaders = opts.headers ?? {};

  let current = opts.url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const dest = await resolveSafeDestination(current);
    const result = await requestOnceImpl({
      url: dest.url,
      method,
      pinned: dest.pinned,
      headers: {
        "User-Agent": "VideoFetch/1.0",
        Accept: "video/*,audio/*,*/*;q=0.8",
        ...userHeaders,
      },
      signal: opts.signal,
      timeoutMs,
    });

    if (REDIRECT_STATUS.has(result.status)) {
      disposeHttpBody(result.body);
      const location = headerValue(result.headers, "location");
      if (!location) throw new AppError("NETWORK_ERROR");
      let next: URL;
      try {
        next = new URL(location, dest.url);
      } catch {
        throw new AppError("INVALID_URL");
      }
      if (hop === maxRedirects) throw new AppError("NETWORK_ERROR");
      current = next.toString();
      continue;
    }

    return {
      url: dest.url.toString(),
      status: result.status,
      headers: result.headers,
      body: result.body,
    };
  }

  throw new AppError("NETWORK_ERROR");
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

export async function safeHead(
  url: string,
  opts?: Omit<SafeHttpRequestOptions, "url" | "method">,
): Promise<SafeHttpResponse> {
  return safeHttpRequest({ ...opts, url, method: "HEAD" });
}

export async function safeGet(
  url: string,
  opts?: Omit<SafeHttpRequestOptions, "url" | "method">,
): Promise<SafeHttpResponse> {
  return safeHttpRequest({ ...opts, url, method: "GET" });
}
