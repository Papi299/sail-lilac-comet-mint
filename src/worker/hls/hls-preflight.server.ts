import { Buffer } from "node:buffer";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { disposeHttpBody, safeGet, type SafeHttpResponse } from "@/lib/security/safe-http.server";
import { validatePublicHttpUrl } from "@/lib/validation/url";
import {
  ClearHlsPlaylistError,
  HLS_V1_MAX_PLAYLIST_BYTES,
  parseClearHlsMediaPlaylist,
  type ClearHlsMediaPlaylist,
  type ClearHlsPlaylistRejection,
} from "./hls-media-playlist.ts";

/**
 * Worker-owned CLEAR-HLS v1 BOUNDED PREFLIGHT (HLS-2).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * One narrow operation: fetch ONE candidate media playlist under a hard byte,
 * redirect and time bound, hand the strictly decoded text to the HLS-1 parser,
 * resolve every approved fragment reference against the FINAL validated
 * response URL, and return a small immutable acquisition plan.
 *
 * It makes exactly one logical request — a GET of the playlist, through the
 * existing hardened `safeGet()`, which may follow a bounded redirect chain.
 * Everything after the body arrives is pure: parsing, URL resolution and static
 * URL policy. No fragment, key, map, variant or rendition is ever requested,
 * and no fragment host is ever looked up.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 * It is not a second HTTP stack: DNS resolution, private-address rejection,
 * address pinning and per-hop redirect validation all stay inside `safeGet()`.
 * It is not a playlist parser either — HLS-1 is the only semantic authority.
 * And it is not fragment transport: HLS-3 will stream the fragment bodies.
 *
 * ─── Dormancy ───────────────────────────────────────────────────────────────
 *
 * Nothing in Production calls this module. HLS remains unadvertised and
 * unselectable: the analyzer's protocol policy is unchanged, so `m3u8_native`
 * is still withheld as `unsupported_protocol`. This is foundation only.
 *
 * ─── Why fragment DNS is deferred, and why BOTH halves are required ─────────
 *
 * The plan's fragment URLs pass a STATIC policy here: http(s) only, no
 * credentials, no blocked or private-literal host. That is NOT a claim that any
 * hostname currently resolves publicly. Resolving up to 10,000 fragment hosts
 * now would be network amplification for no gain, because an answer obtained
 * now is not authoritative for a request made later. HLS-3 will send every
 * fragment request through the same safe-HTTP path, which resolves, rejects any
 * private answer, pins the address and validates every redirect hop AT REQUEST
 * TIME, behind the unchanged kernel egress policy. This static approval and that
 * request-time validation are both required; neither replaces the other.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * The most redirects the playlist request may follow.
 *
 * A hard ceiling for the HLS path that can only NARROW the application policy:
 * the effective limit is the stricter of this and `config.maxRedirects`, so an
 * HLS-specific path can never widen the global redirect policy.
 */
export const HLS_V1_MAX_PLAYLIST_REDIRECTS = 5;

/**
 * The longest fully resolved fragment URL the plan will carry, in UTF-8 bytes.
 *
 * HLS-1 already bounds each REFERENCE to 2 KiB, but a relative reference
 * inherits the playlist URL's origin and directory, and that base is upstream
 * data too. Without this bound a long base multiplies across 10,000 fragments
 * — the plan's memory is set by the source, not by us. Twice the reference bound
 * leaves 2 KiB for the base beneath a maximal reference, and caps the plan's URL
 * text at 10,000 × 4 KiB (about 39 MiB) in the worst case. A source withheld by
 * it fails closed.
 */
export const HLS_V1_MAX_FRAGMENT_URL_BYTES = 4096;

// ── The acquisition plan ─────────────────────────────────────────────────────

/**
 * One approved fragment: a fully resolved, statically approved HTTP(S) URL.
 *
 * Nothing else survives — not the original reference, not its playlist entry.
 * A wrapper rather than a bare string, like HLS-1's, so it cannot be confused
 * with an unvalidated location.
 */
export type ClearHlsAcquisitionFragment = {
  readonly url: string;
};

/**
 * The closed, immutable, Worker-private v1 acquisition plan.
 *
 * SENSITIVE: fragment URLs may be signed. The plan exists in memory only. It
 * must never be logged, serialised into job metadata, persisted, written to
 * disk, returned by any API, or placed in an error.
 *
 * Deliberately absent: the playlist text, the unresolved references, every tag,
 * any key material, titles, format ids, request or response headers, cookies,
 * the redirect chain, and the final playlist URL itself — that URL is used as
 * the resolution base and then discarded.
 */
export type ClearHlsAcquisitionPlan = {
  readonly segmentType: "mpegts";
  readonly fragments: readonly ClearHlsAcquisitionFragment[];
  readonly fragmentCount: number;
};

/**
 * The whole input surface. There is deliberately no way to pass headers,
 * cookies, a referer or a user agent: the request uses the fixed safe-HTTP
 * profile and nothing else (the narrow v1 header policy).
 *
 * `playlistUrl` is PRIVATE Worker data and must never be logged or surfaced.
 * `signal` is REQUIRED so no caller can start an uncancellable preflight.
 * `timeoutMs` defaults to, and is capped at, the existing analysis budget.
 */
export type ClearHlsPreflightRequest = {
  readonly playlistUrl: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
};

// ── Private failures ─────────────────────────────────────────────────────────

/**
 * Why a preflight produced no plan.
 *
 * Worker-private and deliberately NOT a public error code; the later
 * orchestration task maps these onto existing public semantics.
 *
 *   invalid_playlist_url   the supplied URL failed static policy; no I/O ran
 *   destination_rejected   safe-HTTP refused a hop at request time (a private
 *                          DNS answer, or an unsafe redirect target)
 *   network_error          transport failure, including a redirect chain
 *                          longer than the ceiling (safe-HTTP reports both the
 *                          same way) and a response without a body
 *   timeout                the ONE total preflight deadline expired
 *   cancelled              the caller's signal aborted first
 *   playlist_http_status   the final status was not exactly 200
 *   playlist_encoding      a Content-Encoding other than absent or identity
 *   playlist_too_large     declared or streamed body over the playlist ceiling
 *   playlist_invalid_utf8  the body is not well-formed UTF-8
 *   playlist_rejected      HLS-1 refused the document (see `playlistRejection`)
 *   fragment_url_invalid   a fragment reference did not resolve to an
 *                          acceptable URL; the WHOLE plan is refused
 */
export type ClearHlsPreflightFailure =
  | "invalid_playlist_url"
  | "destination_rejected"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "playlist_http_status"
  | "playlist_encoding"
  | "playlist_too_large"
  | "playlist_invalid_utf8"
  | "playlist_rejected"
  | "fragment_url_invalid";

/**
 * A FIXED message per failure, as in HLS-1: with no interpolation site, no URL,
 * redirect location, fragment reference, header value or body text can reach an
 * error string.
 */
const FAILURE_MESSAGES: Record<ClearHlsPreflightFailure, string> = {
  invalid_playlist_url: "playlist location is not an acceptable public HTTP(S) URL",
  destination_rejected: "playlist request was refused by the destination policy",
  network_error: "playlist could not be fetched",
  timeout: "playlist preflight exceeded its deadline",
  cancelled: "playlist preflight was cancelled",
  playlist_http_status: "playlist response status is not acceptable",
  playlist_encoding: "playlist response uses an unsupported content encoding",
  playlist_too_large: "playlist response exceeds the supported size",
  playlist_invalid_utf8: "playlist response is not valid UTF-8",
  playlist_rejected: "playlist is not a supported clear VOD media playlist",
  fragment_url_invalid: "playlist has an unacceptable fragment location",
};

/**
 * A refusal to produce an acquisition plan.
 *
 * Carries a closed `reason` and, for `playlist_rejected` only, the HLS-1 reason
 * enum — never the underlying error, which is dropped rather than attached as a
 * `cause`: a transport error message can name the host it failed to reach.
 */
export class ClearHlsPreflightError extends Error {
  readonly reason: ClearHlsPreflightFailure;
  readonly playlistRejection: ClearHlsPlaylistRejection | null;

  constructor(
    reason: ClearHlsPreflightFailure,
    playlistRejection: ClearHlsPlaylistRejection | null = null,
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "ClearHlsPreflightError";
    this.reason = reason;
    this.playlistRejection = reason === "playlist_rejected" ? playlistRejection : null;
  }
}

function refuse(reason: ClearHlsPreflightFailure): never {
  throw new ClearHlsPreflightError(reason);
}

// ── Static URL policy ────────────────────────────────────────────────────────

/**
 * The static half of the destination policy, for one absolute parsed URL.
 * Returns the approved serialisation, or null.
 *
 * `validatePublicHttpUrl` is reused rather than duplicated: it refuses
 * credentials, an empty or single-label host, blocked names, `.localhost`,
 * `.local`, `.internal`, `.arpa` and private literals of either family. But it
 * deliberately ADMITS `sample:` for Product fixtures, so the http(s)-only rule is
 * enforced here first, explicitly. The comparison at the end makes the string
 * that was checked exactly the string that is stored and later requested.
 */
function staticallyApprovedUrl(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const href = url.href;
  const checked = validatePublicHttpUrl(href);
  if (!checked.ok) return null;
  if (checked.url !== href) return null;
  return href;
}

/**
 * The supplied playlist location, statically approved before ANY I/O.
 *
 * Absolute only: `validatePublicHttpUrl` would coerce a scheme-less string into
 * `https://`, which is right for a person typing into a form and wrong for a
 * Worker-private location that must already say what it is.
 */
function approvedPlaylistUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return staticallyApprovedUrl(parsed);
}

/**
 * One fragment reference resolved against the FINAL response URL, then held to
 * the static policy. Ordinary WHATWG resolution: relative, root-relative,
 * scheme-relative and absolute references all resolve, and a query string —
 * signed or not — is carried exactly as written, never trimmed or rewritten.
 */
function approvedFragmentUrl(reference: string, finalPlaylistUrl: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(reference, finalPlaylistUrl);
  } catch {
    return null;
  }
  if (Buffer.byteLength(resolved.href, "utf8") > HLS_V1_MAX_FRAGMENT_URL_BYTES) return null;
  return staticallyApprovedUrl(resolved);
}

// ── Budgets ──────────────────────────────────────────────────────────────────

/**
 * The ONE total budget for the whole preflight: every DNS lookup, connect,
 * redirect hop and body byte shares it, and no hop gets a fresh one.
 *
 * It defaults to, and is capped at, the existing analysis budget. A budget that
 * is not a positive number is a deadline that has already passed, so nothing
 * starts.
 */
function preflightBudgetMs(requested: number | undefined): number | null {
  const ceiling = config.analysisTimeoutMs;
  const budget = requested === undefined ? ceiling : Math.min(requested, ceiling);
  return Number.isFinite(budget) && budget > 0 ? budget : null;
}

/** The stricter of the application redirect policy and the HLS ceiling. */
function playlistRedirectCeiling(): number {
  return Math.min(HLS_V1_MAX_PLAYLIST_REDIRECTS, Math.floor(config.maxRedirects));
}

// ── Response acceptance ──────────────────────────────────────────────────────

/**
 * Only an absent or explicit `identity` coding is accepted. Decoding gzip or
 * brotli here would let a small compressed body expand past the byte ceiling
 * before anything counted it, and our request never advertises a coding.
 */
function isIdentityEncoding(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "identity";
}

/**
 * Early refusal for a DECLARED oversize body. Never the authority: a
 * Content-Length may be absent, wrong, or smaller than the body that follows,
 * so the streamed counter below decides. An unparseable value is ignored here
 * for the same reason.
 */
function declaresOversizeBody(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const declared = value.trim();
  if (!/^\d+$/.test(declared)) return false;
  return Number(declared) > HLS_V1_MAX_PLAYLIST_BYTES;
}

type HttpBody = NonNullable<SafeHttpResponse["body"]>;

/**
 * Read the body under the playlist ceiling, deciding BEFORE each chunk is kept.
 *
 * One pull-mode consumer. The allowance is checked between receiving a chunk
 * and retaining it, so the offending chunk is never appended and at most the
 * accepted 2 MiB is ever held. Content-Length plays no part.
 */
async function readBoundedPlaylistBody(body: HttpBody): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let playlistBytes = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) refuse("network_error");
    if (playlistBytes + chunk.byteLength > HLS_V1_MAX_PLAYLIST_BYTES) {
      refuse("playlist_too_large");
    }
    chunks.push(chunk);
    playlistBytes += chunk.byteLength;
  }
  return Buffer.concat(chunks, playlistBytes);
}

/**
 * The single logical playlist request and its bounded body.
 *
 * The response body is disposed on EVERY exit — refused status, refused coding,
 * declared or streamed oversize, stream error, cancellation and deadline — and
 * the moment `signal` aborts. If the caller has already been answered by the
 * time a late response arrives, that body is destroyed here on arrival.
 */
async function fetchPlaylistBody(
  playlistUrl: string,
  signal: AbortSignal,
  budgetMs: number,
): Promise<{ bytes: Buffer; finalUrl: string }> {
  const response = await safeGet(playlistUrl, {
    signal,
    timeoutMs: budgetMs,
    maxRedirects: playlistRedirectCeiling(),
  });
  const dispose = () => disposeHttpBody(response.body);
  signal.addEventListener("abort", dispose, { once: true });
  try {
    signal.throwIfAborted();
    if (response.status !== 200) refuse("playlist_http_status");
    if (!isIdentityEncoding(response.headers["content-encoding"])) refuse("playlist_encoding");
    if (declaresOversizeBody(response.headers["content-length"])) refuse("playlist_too_large");
    if (response.body === null) refuse("network_error");
    const bytes = await readBoundedPlaylistBody(response.body);
    // `response.url` is the FINAL validated URL after redirects. It leaves this
    // function only as the resolution base.
    return { bytes, finalUrl: response.url };
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}

// ── Decoding, parsing, resolution ────────────────────────────────────────────

/**
 * Strict UTF-8. `fatal` refuses malformed input instead of substituting U+FFFD,
 * and `ignoreBOM` KEEPS a leading byte order mark in the text, so HLS-1 — not
 * this decoder — is what refuses it.
 */
function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    refuse("playlist_invalid_utf8");
  }
}

/** HLS-1 decides; only its closed reason survives, never the document. */
function parsePlaylist(text: string): ClearHlsMediaPlaylist {
  try {
    return parseClearHlsMediaPlaylist(text);
  } catch (err) {
    throw new ClearHlsPreflightError(
      "playlist_rejected",
      err instanceof ClearHlsPlaylistError ? err.reason : null,
    );
  }
}

/**
 * Resolve every approved reference, in order and with duplicates kept. ONE
 * unacceptable fragment refuses the whole plan: there is no partial plan.
 */
function resolveAcquisitionPlan(
  playlist: ClearHlsMediaPlaylist,
  finalPlaylistUrl: string,
): ClearHlsAcquisitionPlan {
  const fragments: ClearHlsAcquisitionFragment[] = [];
  for (const { reference } of playlist.fragments) {
    const url = approvedFragmentUrl(reference, finalPlaylistUrl);
    if (url === null) refuse("fragment_url_invalid");
    fragments.push(Object.freeze({ url }));
  }
  // The plan, its fragment collection and every entry are frozen, so no caller
  // can replace or rewrite an approved URL between preflight and acquisition.
  return Object.freeze({
    segmentType: playlist.segmentType,
    fragments: Object.freeze(fragments),
    fragmentCount: fragments.length,
  });
}

// ── Stop causes ──────────────────────────────────────────────────────────────

type StopCause = "cancelled" | "timeout";

/**
 * The local controller is aborted with the FIRST stop cause as its reason; a
 * later abort is a no-op, so the first cause is the one reported.
 */
function stopCause(signal: AbortSignal): StopCause {
  return signal.reason === "timeout" ? "timeout" : "cancelled";
}

/**
 * Map anything thrown onto the closed vocabulary. The original error is
 * DROPPED, never wrapped: its message could name a host.
 *
 * Once the caller or the deadline has stopped the preflight, whatever the
 * interrupted operation reported afterwards is a consequence, not the cause.
 */
function classify(err: unknown, signal: AbortSignal): ClearHlsPreflightError {
  if (signal.aborted) return new ClearHlsPreflightError(stopCause(signal));
  if (err instanceof ClearHlsPreflightError) return err;
  if (err instanceof AppError) {
    if (err.code === "INVALID_URL") return new ClearHlsPreflightError("destination_rejected");
    if (err.code === "TIMEOUT") return new ClearHlsPreflightError("timeout");
  }
  return new ClearHlsPreflightError("network_error");
}

// ── The preflight ────────────────────────────────────────────────────────────

/**
 * Fetch, bound, decode, parse and resolve ONE clear-VOD media playlist into an
 * immutable acquisition plan. Throws `ClearHlsPreflightError` otherwise.
 *
 * Lifetime: one local controller carries both stop causes into `safeGet()` and
 * the body read. The function returns no later than the deadline even if an
 * interrupted operation is slow to unwind. Every resource this module owns is
 * released on every exit: the deadline timer is cleared, the caller-signal
 * listener removed, the local controller aborted, and a response body disposed
 * whenever one exists.
 *
 * One resource is NOT this module's to release: an operating-system lookup
 * already in flight cannot be cancelled, since `dns.promises.lookup` takes no
 * signal. The preflight may therefore return on its deadline, or on caller
 * cancellation, while such a lookup is still unwinding. That is bounded rather
 * than open-ended, because safe-HTTP re-checks the abort signal after
 * destination resolution and before a request is built: if the lookup answers
 * later, it is refused there, and no request object, socket or request byte is
 * created from that answer. Cancelling DNS itself is not claimed.
 */
export async function preflightClearHlsMediaPlaylist(
  request: ClearHlsPreflightRequest,
): Promise<ClearHlsAcquisitionPlan> {
  const { playlistUrl, signal, timeoutMs } = request;

  // Nothing starts for a caller that has already gone.
  if (signal.aborted) throw new ClearHlsPreflightError("cancelled");

  const target = approvedPlaylistUrl(playlistUrl);
  if (target === null) throw new ClearHlsPreflightError("invalid_playlist_url");

  const budgetMs = preflightBudgetMs(timeoutMs);
  if (budgetMs === null) throw new ClearHlsPreflightError("timeout");

  const controller = new AbortController();
  const stop = (cause: StopCause) => controller.abort(cause);
  const onCallerAbort = () => stop("cancelled");
  signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), budgetMs);

  // Settles only by rejecting, when either stop cause fires. Racing it means
  // the deadline holds even while an interrupted operation is still unwinding.
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  stopped.catch(() => {});

  try {
    const { bytes, finalUrl } = await Promise.race([
      fetchPlaylistBody(target, controller.signal, budgetMs),
      stopped,
    ]);
    // The parse boundary: a stop that lands after the body completed but
    // before this continuation ran still returns no plan. Everything below is
    // synchronous, so nothing can interleave after this check.
    if (controller.signal.aborted) throw new ClearHlsPreflightError(stopCause(controller.signal));
    return resolveAcquisitionPlan(parsePlaylist(decodeStrictUtf8(bytes)), finalUrl);
  } catch (err) {
    throw classify(err, controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
    controller.abort();
  }
}
