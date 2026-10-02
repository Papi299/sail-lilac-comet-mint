import { Buffer } from "node:buffer";
import { AppError } from "@/lib/errors";
import { disposeHttpBody, safeGet, type SafeHttpResponse } from "@/lib/security/safe-http.server";
import { validatePublicHttpUrl } from "@/lib/validation/url";
import {
  ClearHlsMasterPlaylistError,
  HLS_MASTER_MAX_PLAYLIST_BYTES,
  isJoinStableReference,
  parseClearHlsMasterPlaylist,
  type ClearHlsMasterPlaylist,
  type ClearHlsMasterRejection,
} from "./hls-master-playlist.ts";
import {
  CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES,
  acceptClearHlsPlaylistUrl,
} from "./hls-source-selection.ts";

/**
 * Worker-owned SEPARATE-AUDIO MASTER PROOF
 * (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The one place a separate-audio HLS pair can come into existence. Given a
 * video-only `m3u8_native` rendition analysis accepted — its exact media
 * playlist URL and its `manifest_url` — it fetches that Master Playlist ITSELF,
 * parses it with the closed master grammar, and proves, from the master's own
 * RFC 8216 relationship, which ONE audio media playlist belongs to that video
 * variant. If anything about that proof is missing, ambiguous or outside the
 * grammar, the pair does not exist.
 *
 * ─── The authority, and what is NOT evidence ────────────────────────────────
 *
 * Pairing provenance is the fetched master's `EXT-X-STREAM-INF` → `AUDIO` →
 * `EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID` relationship, and nothing else. yt-dlp's
 * format order, format-id text, NAME, LANGUAGE, bitrates, heights, a single
 * convenient audio row, or any inferred default are never consulted: the
 * pinned runtime pops its own group id before `-J`, so none of them is a
 * relationship. `manifest_url` is not provenance either — it only LOCATES the
 * master whose own content may prove the pair.
 *
 * The proof (`proveSeparateHlsPairing`) requires, for the selected variant:
 *   - EXACTLY ONE `EXT-X-STREAM-INF` whose URI, resolved against the exact
 *     master location requested, is IDENTICAL to the media-playlist URL yt-dlp
 *     reported for the selected row — no closest match, no path or filename
 *     comparison, signed queries significant — and no variant URL listed twice
 *     anywhere in the master;
 *   - that variant's declared `RESOLUTION` agreeing with the row's dimensions;
 *   - an `AUDIO` attribute naming a declared group;
 *   - that group holding EXACTLY ONE rendition, carrying a `URI` (a member
 *     without one is in-band audio, and two members are a choice this
 *     implementation refuses to make: Option A);
 *   - that URI resolving to an acceptable public HTTP(S) URL that is no
 *     variant's URL.
 *
 * ─── The request ────────────────────────────────────────────────────────────
 *
 * ONE `safeGet()` per master through the existing SSRF-pinned transport, with
 * `maxRedirects: 0`: a redirect is a refusal, because the proof binds to the
 * exact master location the fresh extractor analysis named, and a redirected
 * document is a different provenance object. The global redirect policy is not
 * touched. Status exactly 200, absent/identity coding, a 256 KiB body ceiling
 * enforced before each chunk is kept, strict UTF-8, cancellation and one total
 * deadline.
 *
 * ─── Analysis-time bounds ───────────────────────────────────────────────────
 *
 * This runs during ANALYSIS, so it is bounded tightly: identical master URLs
 * are fetched once; at most `SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS` distinct
 * masters are fetched per analysis — exceeding it withholds separate HLS
 * entirely rather than proving an arbitrary subset; each fetch is capped at
 * `SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS` and all of them share the caller's
 * remaining analysis budget. It never requests a media playlist, an
 * initialization map or a media segment, and moves no media bytes.
 *
 * ─── Privacy ────────────────────────────────────────────────────────────────
 *
 * The master URL, the media-playlist URLs, any signed query, the master text,
 * group ids, NAMEs and LANGUAGEs are SENSITIVE. None is logged, persisted,
 * returned beyond the two proven URLs, or interpolated into an error: every
 * failure here is a closed private reason with a fixed message, and analysis
 * reads a failure simply as "this pair does not exist".
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * The most DISTINCT master documents one analysis may fetch.
 *
 * yt-dlp emits every format of one HLS master with that master's
 * `manifest_url`, so an ordinary source needs exactly one. Extractors that
 * merge several masters (per-CDN or per-codec ladders) need a handful. The
 * analysis document's own ceiling is 512 raw formats; this cap keeps the
 * request count independent of it, so no number of rows can turn analysis into
 * a crawler. Exceeding it withholds separate HLS for the whole analysis — never
 * a truncated, order-dependent subset.
 */
export const SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS = 4;

/**
 * The longest one master fetch may take, in milliseconds — the same ten
 * seconds the analysis subprocess allows a socket. Every fetch is additionally
 * bounded by the caller's remaining analysis budget.
 */
export const SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS = 10_000;

// ── Master location acceptance ───────────────────────────────────────────────

/**
 * One raw `manifest_url`, screened before it may be requested. Pure string
 * work: no DNS, no request.
 *
 * It must be an absolute, lowercase-scheme http(s) URL inside the join-stable
 * subset — already in WHATWG canonical form, with no dot or empty path segment,
 * no trailing slash, no empty query and no `;` — within the 4 KiB playlist-URL
 * ceiling, and statically public with no credentials. The value requested is
 * EXACTLY the value yt-dlp reported: nothing is canonicalised into acceptance.
 *
 * Returns the accepted string, or `null` — "no master can be located", never an
 * analysis failure.
 */
export function acceptClearHlsMasterUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES) return null;
  if (Buffer.byteLength(raw, "utf8") > CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES) return null;
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return null;
  if (!isJoinStableReference(raw)) return null;
  const checked = validatePublicHttpUrl(raw);
  if (!checked.ok || checked.url !== raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.href !== raw || parsed.username !== "" || parsed.password !== "") return null;
  return raw;
}

// ── The master fetch ─────────────────────────────────────────────────────────

/**
 * Why a master could not be obtained. Worker-private; analysis maps every one of
 * them to "the pair does not exist".
 *
 *   invalid_master_url      the location failed static acceptance; no I/O ran
 *   destination_rejected    safe-HTTP refused the destination at request time
 *   network_error           transport failure — INCLUDING any redirect, which
 *                           `maxRedirects: 0` refuses without following
 *   timeout                 the one fetch deadline expired
 *   cancelled               the caller's signal aborted first
 *   master_http_status      the status was not exactly 200
 *   master_encoding         a Content-Encoding other than absent or identity
 *   master_too_large        declared or streamed body over the master ceiling
 *   master_invalid_utf8     the body is not well-formed UTF-8
 *   master_location_changed the response names a location other than the one
 *                           requested
 *   master_rejected         the closed master grammar refused the document
 */
export type ClearHlsMasterFetchFailure =
  | "invalid_master_url"
  | "destination_rejected"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "master_http_status"
  | "master_encoding"
  | "master_too_large"
  | "master_invalid_utf8"
  | "master_location_changed"
  | "master_rejected";

const FETCH_FAILURE_MESSAGES: Record<ClearHlsMasterFetchFailure, string> = {
  invalid_master_url: "master location is not an acceptable public HTTP(S) URL",
  destination_rejected: "master request was refused by the destination policy",
  network_error: "master could not be fetched",
  timeout: "master fetch exceeded its deadline",
  cancelled: "master fetch was cancelled",
  master_http_status: "master response status is not acceptable",
  master_encoding: "master response uses an unsupported content encoding",
  master_too_large: "master response exceeds the supported size",
  master_invalid_utf8: "master response is not valid UTF-8",
  master_location_changed: "master response does not describe the requested location",
  master_rejected: "master is not a supported master playlist",
};

export class ClearHlsMasterFetchError extends Error {
  readonly reason: ClearHlsMasterFetchFailure;
  readonly masterRejection: ClearHlsMasterRejection | null;

  constructor(reason: ClearHlsMasterFetchFailure, masterRejection: ClearHlsMasterRejection | null = null) {
    super(FETCH_FAILURE_MESSAGES[reason]);
    this.name = "ClearHlsMasterFetchError";
    this.reason = reason;
    this.masterRejection = reason === "master_rejected" ? masterRejection : null;
  }
}

function refuseFetch(reason: ClearHlsMasterFetchFailure): never {
  throw new ClearHlsMasterFetchError(reason);
}

type HttpBody = NonNullable<SafeHttpResponse["body"]>;

function isIdentityEncoding(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "identity";
}

function declaresOversizeBody(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const declared = value.trim();
  if (!/^\d+$/.test(declared)) return false;
  return Number(declared) > HLS_MASTER_MAX_PLAYLIST_BYTES;
}

/** One pull-mode consumer: the ceiling is checked before a chunk is kept. */
async function readBoundedMasterBody(body: HttpBody): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) refuseFetch("network_error");
    if (total + chunk.byteLength > HLS_MASTER_MAX_PLAYLIST_BYTES) refuseFetch("master_too_large");
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return Buffer.concat(chunks, total);
}

/**
 * The single zero-redirect request and its bounded body. The body is disposed
 * on every exit and the moment `signal` aborts.
 */
async function fetchMasterBody(masterUrl: string, signal: AbortSignal, budgetMs: number): Promise<Buffer> {
  const response = await safeGet(masterUrl, { signal, timeoutMs: budgetMs, maxRedirects: 0 });
  const dispose = () => disposeHttpBody(response.body);
  signal.addEventListener("abort", dispose, { once: true });
  try {
    signal.throwIfAborted();
    if (response.status !== 200) refuseFetch("master_http_status");
    // With no redirect followed, the response describes exactly the location
    // requested. Anything else is a different provenance object.
    if (response.url !== masterUrl) refuseFetch("master_location_changed");
    if (!isIdentityEncoding(response.headers["content-encoding"])) refuseFetch("master_encoding");
    if (declaresOversizeBody(response.headers["content-length"])) refuseFetch("master_too_large");
    if (response.body === null) refuseFetch("network_error");
    return await readBoundedMasterBody(response.body);
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    refuseFetch("master_invalid_utf8");
  }
}

function parseMaster(text: string): ClearHlsMasterPlaylist {
  try {
    return parseClearHlsMasterPlaylist(text);
  } catch (err) {
    throw new ClearHlsMasterFetchError(
      "master_rejected",
      err instanceof ClearHlsMasterPlaylistError ? err.reason : null,
    );
  }
}

type StopCause = "cancelled" | "timeout";

/**
 * Fetch, bound, decode and parse ONE master under one deadline, with zero
 * redirects. Throws `ClearHlsMasterFetchError`; the underlying error is always
 * dropped, never wrapped, because a transport message can name a host.
 *
 * Like the media-playlist preflight, the deadline is RACED, so the function
 * returns on time even while an interrupted operation unwinds; an OS DNS lookup
 * already in flight cannot be cancelled, but safe-HTTP refuses to build a
 * request from its late answer.
 */
export async function fetchClearHlsMasterPlaylist(request: {
  readonly masterUrl: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<ClearHlsMasterPlaylist> {
  const { masterUrl, signal, timeoutMs } = request;
  if (signal.aborted) throw new ClearHlsMasterFetchError("cancelled");
  const target = acceptClearHlsMasterUrl(masterUrl);
  if (target === null) throw new ClearHlsMasterFetchError("invalid_master_url");
  const budgetMs = Math.min(timeoutMs, SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new ClearHlsMasterFetchError("timeout");

  const controller = new AbortController();
  const stop = (cause: StopCause) => controller.abort(cause);
  const onCallerAbort = () => stop("cancelled");
  signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), budgetMs);
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  stopped.catch(() => {});

  const stopCause = (): StopCause => (controller.signal.reason === "timeout" ? "timeout" : "cancelled");
  try {
    const bytes = await Promise.race([fetchMasterBody(target, controller.signal, budgetMs), stopped]);
    if (controller.signal.aborted) throw new ClearHlsMasterFetchError(stopCause());
    return parseMaster(decodeStrictUtf8(bytes));
  } catch (err) {
    if (controller.signal.aborted) throw new ClearHlsMasterFetchError(stopCause());
    if (err instanceof ClearHlsMasterFetchError) throw err;
    if (err instanceof AppError) {
      if (err.code === "INVALID_URL") throw new ClearHlsMasterFetchError("destination_rejected");
      if (err.code === "TIMEOUT") throw new ClearHlsMasterFetchError("timeout");
    }
    throw new ClearHlsMasterFetchError("network_error");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
    controller.abort();
  }
}

// ── The association proof ────────────────────────────────────────────────────

/**
 * One video-only rendition analysis accepted as a separate-audio CANDIDATE.
 * Transient and private: it exists inside one analysis pass only.
 *
 *   videoPlaylistUrl  yt-dlp's media-playlist URL for the row, accepted and
 *                     already in canonical form;
 *   masterUrl         the accepted `manifest_url` — a locator, never evidence;
 *   width / height    the row's RAW dimensions (positive safe integers, else
 *                     null), used only as a consistency check against the
 *                     master's `RESOLUTION`;
 *   index             the row's upstream position, for deterministic placement.
 */
export type SeparateHlsVideoCandidate = {
  readonly videoPlaylistUrl: string;
  readonly masterUrl: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly index: number;
};

/** A candidate whose audio half the master proved. `masterUrl` is gone. */
export type SeparateHlsProvenPair = {
  readonly videoPlaylistUrl: string;
  readonly audioPlaylistUrl: string;
  readonly height: number | null;
  readonly index: number;
};

/** Why a master does not prove a pair for one candidate. Worker-private. */
export type SeparateHlsPairingRefusal =
  | "variant_url_unresolvable"
  | "duplicate_variant_url"
  | "selected_variant_not_in_master"
  | "variant_resolution_inconsistent"
  | "variant_has_no_audio_group"
  | "audio_group_has_in_band_member"
  | "ambiguous_audio_group"
  | "audio_url_invalid"
  | "audio_url_is_variant_url";

export type SeparateHlsPairingResult =
  | { readonly ok: true; readonly audioPlaylistUrl: string }
  | { readonly ok: false; readonly refusal: SeparateHlsPairingRefusal };

/** WHATWG resolution of one join-stable reference against the master location. */
function resolveReference(reference: string, masterUrl: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(reference, masterUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (Buffer.byteLength(resolved.href, "utf8") > CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES) return null;
  return resolved.href;
}

/**
 * PURE: does this parsed master prove exactly one audio media playlist for
 * this candidate? No I/O, no clock. Exported so the association rules can be
 * pinned without a network.
 */
export function proveSeparateHlsPairing(
  master: ClearHlsMasterPlaylist,
  masterUrl: string,
  candidate: SeparateHlsVideoCandidate,
): SeparateHlsPairingResult {
  const fail = (refusal: SeparateHlsPairingRefusal): SeparateHlsPairingResult => ({ ok: false, refusal });

  const variantUrls: string[] = [];
  for (const variant of master.variants) {
    const url = resolveReference(variant.reference, masterUrl);
    if (url === null) return fail("variant_url_unresolvable");
    variantUrls.push(url);
  }
  // One media playlist listed twice is two possible associations; the master
  // is ambiguous as a provenance object, whichever variant was selected.
  if (new Set(variantUrls).size !== variantUrls.length) return fail("duplicate_variant_url");

  const at = variantUrls.indexOf(candidate.videoPlaylistUrl);
  if (at === -1) return fail("selected_variant_not_in_master");
  const variant = master.variants[at]!;

  // RESOLUTION is a consistency check only, in both directions: the row yt-dlp
  // reported must describe the very variant line that matched.
  if (variant.resolution === null) {
    if (candidate.width !== null || candidate.height !== null) return fail("variant_resolution_inconsistent");
  } else if (variant.resolution.width !== candidate.width || variant.resolution.height !== candidate.height) {
    return fail("variant_resolution_inconsistent");
  }

  if (variant.audioGroup === null) return fail("variant_has_no_audio_group");
  const members = master.audioGroups[variant.audioGroup];
  if (members === undefined || members.length === 0) return fail("variant_has_no_audio_group");
  if (members.some((member) => member.reference === null)) return fail("audio_group_has_in_band_member");
  if (members.length !== 1) return fail("ambiguous_audio_group");

  const audioReference = members[0]!.reference!;
  const resolved = resolveReference(audioReference, masterUrl);
  if (resolved === null) return fail("audio_url_invalid");
  // The same static acceptance every retained playlist URL gets, returning the
  // SAME string: public http(s), no credentials, bounded.
  if (acceptClearHlsPlaylistUrl(resolved) !== resolved) return fail("audio_url_invalid");
  if (variantUrls.includes(resolved)) return fail("audio_url_is_variant_url");
  return { ok: true, audioPlaylistUrl: resolved };
}

/**
 * Prove every candidate it can, within the analysis bounds. Never throws for a
 * refusal: a candidate that cannot be proven is simply absent from the result.
 *
 *   - candidates are grouped by master URL; each master is fetched at most once;
 *   - more than `SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS` distinct masters means
 *     NO fetch and NO pair;
 *   - masters are fetched sequentially, each capped at
 *     `SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS` and all within `timeoutMs`;
 *   - a master that cannot be fetched or parsed proves nothing for its
 *     candidates and does not affect another master's;
 *   - once `signal` aborts, nothing further is fetched and nothing is proven —
 *     the caller decides what its own cancellation means.
 */
export async function proveSeparateHlsAudioPairs(request: {
  readonly candidates: readonly SeparateHlsVideoCandidate[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<readonly SeparateHlsProvenPair[]> {
  const { candidates, timeoutMs } = request;
  const signal = request.signal ?? new AbortController().signal;
  if (candidates.length === 0 || signal.aborted) return Object.freeze([]);

  const byMaster = new Map<string, SeparateHlsVideoCandidate[]>();
  for (const candidate of candidates) {
    const list = byMaster.get(candidate.masterUrl) ?? [];
    list.push(candidate);
    byMaster.set(candidate.masterUrl, list);
  }
  if (byMaster.size > SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS) return Object.freeze([]);

  const deadline = performance.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 0);
  const proven: SeparateHlsProvenPair[] = [];
  for (const [masterUrl, members] of byMaster) {
    if (signal.aborted) return Object.freeze([]);
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    let master: ClearHlsMasterPlaylist;
    try {
      master = await fetchClearHlsMasterPlaylist({ masterUrl, signal, timeoutMs: remaining });
    } catch {
      // Unprovable: these candidates do not exist. The private reason is
      // dropped here; it never reaches analysis output or an error.
      continue;
    }
    for (const candidate of members) {
      const result = proveSeparateHlsPairing(master, masterUrl, candidate);
      if (!result.ok) continue;
      proven.push(
        Object.freeze({
          videoPlaylistUrl: candidate.videoPlaylistUrl,
          audioPlaylistUrl: result.audioPlaylistUrl,
          height: candidate.height,
          index: candidate.index,
        }),
      );
    }
  }
  if (signal.aborted) return Object.freeze([]);
  return Object.freeze(proven);
}
