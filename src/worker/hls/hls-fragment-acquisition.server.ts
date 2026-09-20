import { Buffer } from "node:buffer";
import { open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { disposeHttpBody, safeGet, type SafeHttpResponse } from "@/lib/security/safe-http.server";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "@/shared/media-limits";
import { HLS_V1_MAX_FRAGMENTS } from "./hls-media-playlist.ts";
import {
  HLS_V1_MAX_FRAGMENT_URL_BYTES,
  type ClearHlsAcquisitionPlan,
} from "./hls-preflight.server.ts";

/**
 * Worker-owned CLEAR-HLS v1 SEQUENTIAL FRAGMENT ACQUISITION (HLS-3).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The first HLS component permitted to move media bytes. It consumes ONE
 * already-approved HLS-2 acquisition plan and downloads its MPEG-TS fragments
 * one at a time into exactly ONE local aggregate artifact — the byte-exact
 * concatenation of every fragment, in plan order.
 *
 * Every fragment is fetched through the existing hardened `safeGet()`, so DNS
 * resolution, private-answer rejection, address pinning and per-hop redirect
 * validation happen AT REQUEST TIME for each fragment, behind the unchanged
 * kernel egress policy. HLS-2's static approval of a fragment URL is a
 * necessary precondition, never a substitute for that.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 * It is not a media component. It does not parse TS packets, rewrite
 * timestamps, repair discontinuities, inspect codecs, remux, or run FFmpeg,
 * ffprobe or yt-dlp — HLS-4 owns validation and TS → MP4 after
 * `beginProcessing()`. The artifact this module produces is raw MPEG-TS and is
 * never described as MP4.
 *
 * It is not a resilience layer either. v1 performs ZERO retries: one approved
 * fragment gets one logical `safeGet()`, and one failed fragment fails the
 * whole acquisition. That is deliberate — a retry would have to reason about
 * how much of the failed fragment had already been appended, and v1 discards
 * the whole partial artifact instead of carrying rollback semantics.
 *
 * ─── Dormancy ───────────────────────────────────────────────────────────────
 *
 * Nothing in Production calls this module. HLS remains unadvertised and
 * unselectable: the analyzer's protocol policy is unchanged, so `m3u8_native`
 * is still withheld as `unsupported_protocol`. This is foundation only.
 *
 * ─── The byte path ──────────────────────────────────────────────────────────
 *
 *   response chunk → per-fragment bound → aggregate bound → awaited write
 *
 * There is no whole-fragment buffer anywhere: no `Buffer.concat`, no chunk
 * array, no per-fragment temp file. Each chunk is admitted or refused BEFORE
 * any of its bytes are written, and the write is awaited before the next chunk
 * is pulled, so memory use is set by the transport's own chunk size and not by
 * the fragment's size.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * The most bytes ONE fragment may contribute: 64 MiB, exactly 67,108,864.
 *
 * A clear-VOD fragment is a few seconds of media; anything at this scale is a
 * malformed or hostile source, not a segment. Bounding each fragment as well
 * as the total keeps a single runaway response from consuming the whole
 * delivered-media budget before the aggregate bound would notice.
 */
export const HLS_V1_MAX_FRAGMENT_BYTES = 64 * 1024 * 1024;

/**
 * The hard aggregate ceiling for HLS v1: the shared Product delivered-media
 * limit, exactly 4,294,967,296 bytes.
 *
 * Taken from the one shared constant rather than restated, so HLS can never
 * drift away from the limit the rest of the Worker enforces.
 */
export const HLS_V1_MAX_AGGREGATE_BYTES = DEFAULT_MAX_FILE_SIZE_BYTES;

/**
 * The most redirects ONE fragment request may follow.
 *
 * A hard ceiling that can only NARROW the application policy: the effective
 * limit is the stricter of this and `config.maxRedirects`, so the HLS path can
 * never widen the global redirect policy.
 */
export const HLS_V1_MAX_FRAGMENT_REDIRECTS = 5;

/**
 * The aggregate bound this acquisition will actually enforce.
 *
 * A LOWER operator-configured Product limit is honoured, and a HIGHER one
 * cannot widen HLS v1: the 4 GiB ceiling is absolute. There is deliberately no
 * HLS-specific environment variable — one more knob would be one more way for
 * the HLS path and the rest of the Worker to disagree about how large a
 * delivered file may be.
 *
 * A configured limit that is not a finite number is treated as no capacity at
 * all rather than as "unbounded", so a broken configuration fails closed.
 */
export function hlsV1EffectiveAggregateLimitBytes(): number {
  const configured = Math.floor(config.maxFileSize);
  if (!Number.isFinite(configured) || configured < 0) return 0;
  return Math.min(configured, HLS_V1_MAX_AGGREGATE_BYTES);
}

/** The stricter of the application redirect policy and the HLS ceiling. */
function fragmentRedirectCeiling(): number {
  return Math.min(HLS_V1_MAX_FRAGMENT_REDIRECTS, Math.floor(config.maxRedirects));
}

// ── Fixed artifact names ─────────────────────────────────────────────────────

/**
 * The finished aggregate, and the partial it is renamed from.
 *
 * Application-owned constants, not derived values. No fragment URL, hostname,
 * query parameter, playlist datum or upstream index participates in any path
 * this module opens, renames or unlinks — the only caller-supplied component is
 * the server-owned job workDir itself.
 *
 * `AGGREGATE_FILE_NAME` is EXPORTED for HLS-4 alone, which must prove that the
 * artifact it was handed really is the one this module produces rather than
 * merely some regular file that happens to sit in the same directory. Sharing
 * the constant keeps that identity check single-sourced; restating the literal
 * in the processing module would let the two drift apart silently. This is an
 * added export and nothing else: no behaviour, no path, no bound and no
 * lifecycle step of HLS-3 changes with it, and HLS-3 still performs no local
 * media processing of any kind.
 */
export const AGGREGATE_FILE_NAME = "hls-source.ts";
const PARTIAL_FILE_NAME = "hls-source.ts.part";

// ── The acquired artifact ────────────────────────────────────────────────────

/**
 * What a successful acquisition produced.
 *
 * `segmentType` is MPEG-TS and is stated as such: this is NOT an MP4 and must
 * never be given an MP4 container or MIME. `fileSize` is the verified on-disk
 * size, which equals the streamed aggregate counter.
 */
export type ClearHlsAcquiredTs = {
  readonly filePath: string;
  readonly segmentType: "mpegts";
  readonly fileSize: number;
};

/**
 * Truthful fragment-count progress.
 *
 * Authority is `completedFragments / fragmentCount`, with ONE reservation: the
 * terminal 100 is not emitted when the last fragment's bytes land, but only
 * once the aggregate artifact has been finalized, verified and COMMITTED and
 * the acquisition is about to return it. A caller that sees 100 has a finished
 * file; an acquisition that fails never reports 100. Byte totals are NOT
 * inferred: a clear-VOD playlist declares durations, not sizes, so the total
 * transfer size is genuinely unknown until the last fragment ends. `totalBytes`
 * is therefore always null, and so are `speed` and `eta` — an invented ETA is
 * worse than none. Worker-private; no public contract changes here.
 */
export type ClearHlsAcquisitionProgress = {
  readonly progress: number;
  readonly downloadedBytes: number;
  readonly totalBytes: null;
  readonly speed: null;
  readonly eta: null;
  readonly stage: "downloading";
};

/**
 * The whole input surface.
 *
 * Deliberately absent: a playlist URL, playlist text, unresolved references,
 * yt-dlp format ids, browser selectors, request headers, cookies, a Referer
 * and an Authorization. HLS-2 is the only component that turns a playlist into
 * a plan, and every request uses the fixed safe-HTTP profile and nothing else.
 *
 * `workDir` is the server-owned per-job directory; it must already exist and
 * must be absolute. `signal` is REQUIRED so no caller can start an
 * uncancellable acquisition. `timeoutMs` may only NARROW the download budget.
 */
export type ClearHlsAcquisitionRequest = {
  readonly plan: ClearHlsAcquisitionPlan;
  readonly workDir: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: ClearHlsAcquisitionProgress) => void;
};

// ── Private failures ─────────────────────────────────────────────────────────

/**
 * Why an acquisition produced no artifact.
 *
 * Worker-private and deliberately NOT a public error code; the later
 * orchestration task maps these onto existing public semantics (source failure
 * → extraction semantics, aggregate overflow → TOO_LARGE, timeout → TIMEOUT,
 * local output failure → the existing processing/infrastructure semantics).
 *
 *   invalid_plan           the supplied plan failed its structural gate; no
 *                          network or filesystem work ran
 *   destination_rejected   safe-HTTP refused a hop at request time (a private
 *                          DNS answer, or an unsafe redirect target)
 *   network_error          transport failure, including a redirect chain
 *                          longer than the ceiling (safe-HTTP reports both the
 *                          same way), a response without a body, a body that
 *                          ended early, and a fragment whose delivered length
 *                          disagreed with its own Content-Length
 *   timeout                the ONE total acquisition deadline expired
 *   cancelled              the caller's signal aborted first
 *   fragment_http_status   a final fragment status was not exactly 200
 *   fragment_encoding      a Content-Encoding other than absent or identity
 *   fragment_too_large     one fragment declared or streamed past 64 MiB
 *   aggregate_too_large    the delivered total would pass the effective limit
 *   output_error           the local aggregate could not be created, written,
 *                          verified or finalized
 */
export type ClearHlsAcquisitionFailure =
  | "invalid_plan"
  | "destination_rejected"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "fragment_http_status"
  | "fragment_encoding"
  | "fragment_too_large"
  | "aggregate_too_large"
  | "output_error";

/**
 * A FIXED message per failure, as in HLS-1 and HLS-2: with no interpolation
 * site, no fragment URL, hostname, query, redirect location, response body,
 * filesystem path or underlying transport message can reach an error string.
 */
const FAILURE_MESSAGES: Record<ClearHlsAcquisitionFailure, string> = {
  invalid_plan: "acquisition plan is not a valid clear HLS plan",
  destination_rejected: "fragment request was refused by the destination policy",
  network_error: "fragment could not be fetched",
  timeout: "fragment acquisition exceeded its deadline",
  cancelled: "fragment acquisition was cancelled",
  fragment_http_status: "fragment response status is not acceptable",
  fragment_encoding: "fragment response uses an unsupported content encoding",
  fragment_too_large: "fragment exceeds the supported size",
  aggregate_too_large: "fragments exceed the supported total size",
  output_error: "fragment acquisition could not write its local artifact",
};

/**
 * A refusal to produce an acquired artifact.
 *
 * Carries only a closed `reason`. The underlying error is DROPPED rather than
 * attached as a `cause`: a transport error message can name the host it failed
 * to reach, and an errno message carries a filesystem path.
 */
export class ClearHlsAcquisitionError extends Error {
  readonly reason: ClearHlsAcquisitionFailure;

  constructor(reason: ClearHlsAcquisitionFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "ClearHlsAcquisitionError";
    this.reason = reason;
  }
}

function refuse(reason: ClearHlsAcquisitionFailure): never {
  throw new ClearHlsAcquisitionError(reason);
}

// ── Plan integrity ───────────────────────────────────────────────────────────

/**
 * Defence in depth before any network or filesystem work.
 *
 * A plan reaching here should always be one HLS-2 built, so this is not a
 * second URL policy — it is a structural gate that refuses a forged or mutated
 * object before a single media byte is written. It re-states the shape HLS-2
 * guarantees, including the freezing, so a plan that was tampered with after
 * preflight cannot redirect acquisition anywhere.
 *
 * Every actual request still goes through `safeGet()`, which is what decides
 * whether a URL may be contacted.
 */
function isApprovedPlan(plan: unknown): plan is ClearHlsAcquisitionPlan {
  if (typeof plan !== "object" || plan === null) return false;
  if (!Object.isFrozen(plan)) return false;

  const candidate = plan as {
    segmentType?: unknown;
    fragments?: unknown;
    fragmentCount?: unknown;
  };
  if (candidate.segmentType !== "mpegts") return false;

  const { fragments, fragmentCount } = candidate;
  if (!Array.isArray(fragments) || !Object.isFrozen(fragments)) return false;
  if (typeof fragmentCount !== "number" || !Number.isSafeInteger(fragmentCount)) return false;
  if (fragmentCount <= 0 || fragmentCount > HLS_V1_MAX_FRAGMENTS) return false;
  if (fragmentCount !== fragments.length) return false;

  for (const entry of fragments) {
    if (typeof entry !== "object" || entry === null) return false;
    if (!Object.isFrozen(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.length !== 1 || keys[0] !== "url") return false;
    const { url } = entry as { url: unknown };
    if (typeof url !== "string" || url.length === 0) return false;
    if (Buffer.byteLength(url, "utf8") > HLS_V1_MAX_FRAGMENT_URL_BYTES) return false;
  }
  return true;
}

// ── Output paths ─────────────────────────────────────────────────────────────

type AcquisitionPaths = {
  readonly partialPath: string;
  readonly aggregatePath: string;
};

/**
 * The two fixed paths inside the supplied workDir, or null if the workDir is
 * not a usable absolute directory reference.
 *
 * The only variable component is the workDir the Worker itself owns. Both file
 * names are module constants, so no upstream string participates in path
 * construction and no directory is ever created here.
 */
function acquisitionPaths(workDir: unknown): AcquisitionPaths | null {
  if (typeof workDir !== "string" || workDir.length === 0) return null;
  if (!isAbsolute(workDir)) return null;
  const base = resolve(workDir);
  return {
    partialPath: join(base, PARTIAL_FILE_NAME),
    aggregatePath: join(base, AGGREGATE_FILE_NAME),
  };
}

/** Whether a path currently exists; an unstatable path counts as absent. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort removal. A path that is already gone is the desired state. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already absent, or the directory refuses the removal; either way there
    // is nothing further this module can do about it.
    return;
  }
}

/** Best-effort close, so a failing close cannot mask the real failure. */
async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    return;
  }
}

// ── Response acceptance ──────────────────────────────────────────────────────

type HttpBody = NonNullable<SafeHttpResponse["body"]>;

/**
 * Only an absent or explicit `identity` coding is accepted. HLS-3 appends EXACT
 * media bytes: decoding gzip or brotli here would both change the bytes and let
 * a small compressed response expand past a ceiling before anything counted it.
 * Our request never advertises a coding in the first place.
 */
function isIdentityEncoding(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "identity";
}

/**
 * A syntactically valid non-negative Content-Length, or null.
 *
 * Never the resource authority — it may be absent, wrong, or smaller than the
 * body that follows — but when it IS present it earns two jobs: an early
 * refusal before a single body byte is pulled, and a completeness check after
 * the body ends. An unparseable value is treated as absent.
 */
function declaredLength(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const declared = value.trim();
  if (!/^\d+$/.test(declared)) return null;
  const parsed = Number(declared);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The chunk admission rule, and the ONE place the two hard bounds are decided.
 *
 * Called BEFORE any byte of `length` is written. Precedence is fixed so
 * classification is deterministic: a fragment that is itself too big is
 * `fragment_too_large` even when it would also have exhausted the total, and
 * only a fragment that fits its own ceiling can report `aggregate_too_large`.
 * The same precedence governs the early Content-Length refusal.
 */
function admitBytes(
  fragmentBytes: number,
  aggregateBytes: number,
  length: number,
  aggregateLimit: number,
): void {
  if (fragmentBytes + length > HLS_V1_MAX_FRAGMENT_BYTES) refuse("fragment_too_large");
  if (aggregateBytes + length > aggregateLimit) refuse("aggregate_too_large");
}

/**
 * Write one chunk completely.
 *
 * `FileHandle.write` may consume less than the whole buffer, so the remainder
 * is written in a loop rather than assumed away — a short write that was
 * silently dropped would corrupt the concatenation. Awaiting each write is also
 * what provides backpressure: the next chunk is not pulled until this one is on
 * its way to the file.
 */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await handle.write(chunk, written, chunk.byteLength - written);
    if (result.bytesWritten <= 0) refuse("output_error");
    written += result.bytesWritten;
  }
}

// ── One fragment ─────────────────────────────────────────────────────────────

type FragmentContext = {
  readonly handle: FileHandle;
  readonly signal: AbortSignal;
  readonly budgetMs: number;
  readonly aggregateLimit: number;
};

/**
 * Fetch ONE fragment and append it, returning the new aggregate total.
 *
 * Exactly one logical `safeGet()` — no HEAD, no probe, no prefetch, no retry.
 * Redirect hops inside that one logical GET are not retries and are bounded by
 * the fragment redirect ceiling.
 *
 * `safeGet`'s `timeoutMs` is a socket INACTIVITY timeout underneath the
 * absolute acquisition deadline, not a replacement for it: the deadline is
 * carried by `signal`, which is the operation's own controller.
 *
 * The response body is disposed on EVERY exit — refused status, refused coding,
 * declared or streamed overflow, stream error, cancellation and deadline — and
 * the moment `signal` aborts, so no body keeps being consumed after the
 * acquisition has already failed.
 */
async function acquireFragment(
  url: string,
  aggregateBytes: number,
  ctx: FragmentContext,
): Promise<number> {
  const { handle, signal, budgetMs, aggregateLimit } = ctx;
  const response = await safeGet(url, {
    signal,
    timeoutMs: budgetMs,
    maxRedirects: fragmentRedirectCeiling(),
  });
  const dispose = () => disposeHttpBody(response.body);
  signal.addEventListener("abort", dispose, { once: true });
  try {
    // The response may have arrived after the operation was already stopped.
    signal.throwIfAborted();
    if (response.status !== 200) refuse("fragment_http_status");
    if (!isIdentityEncoding(response.headers["content-encoding"])) refuse("fragment_encoding");

    // Early refusal, before a single body byte is pulled. Same precedence as
    // the streamed rule, so a declared and a streamed overflow of the same
    // shape are classified identically.
    const declared = declaredLength(response.headers["content-length"]);
    if (declared !== null) admitBytes(0, aggregateBytes, declared, aggregateLimit);
    if (response.body === null) refuse("network_error");

    let fragmentBytes = 0;
    let total = aggregateBytes;
    for await (const chunk of response.body as HttpBody) {
      if (!(chunk instanceof Uint8Array)) refuse("network_error");
      const length = chunk.byteLength;
      admitBytes(fragmentBytes, total, length, aggregateLimit);
      await writeAll(handle, chunk);
      fragmentBytes += length;
      total += length;
    }
    // A body destroyed without an error ends the iteration normally; a stop
    // that lands here must not be mistaken for a complete fragment.
    signal.throwIfAborted();
    // Completeness only. A body that stopped short of, or ran past, its own
    // declared length was not delivered intact — and the streamed counters
    // above have already refused anything beyond either hard bound, so this can
    // never admit bytes that a limit would have refused.
    if (declared !== null && fragmentBytes !== declared) refuse("network_error");
    return total;
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}

// ── The sequential transfer ──────────────────────────────────────────────────

/**
 * Every fragment, strictly in plan order, into one open aggregate handle.
 *
 * ONE request at a time: fragment N's body is fully consumed and disposed
 * before fragment N+1 is even resolved. There is no concurrency, no prefetch
 * and no speculative request, which is what makes the byte accounting and the
 * output ordering deterministic.
 *
 * Duplicate URLs are positions, not identities: a plan that lists the same
 * fragment twice is fetched twice and appended twice, in order.
 *
 * The aggregate counter is established once, before the first fragment, and is
 * never reset — not between fragments, and not across a redirect.
 */
async function transferFragments(
  plan: ClearHlsAcquisitionPlan,
  handle: FileHandle,
  signal: AbortSignal,
  budgetMs: number,
  onProgress: ClearHlsAcquisitionRequest["onProgress"],
): Promise<number> {
  const aggregateLimit = hlsV1EffectiveAggregateLimitBytes();
  const ctx: FragmentContext = { handle, signal, budgetMs, aggregateLimit };
  let aggregateBytes = 0;
  let completed = 0;
  reportSafely(onProgress, completed, aggregateBytes, plan.fragmentCount);
  for (const fragment of plan.fragments) {
    // No next fragment begins once the operation has been stopped.
    signal.throwIfAborted();
    aggregateBytes = await acquireFragment(fragment.url, aggregateBytes, ctx);
    completed += 1;
    // Only a fragment whose whole body was accepted AND written counts, and
    // the LAST one is deliberately withheld here: 100 belongs to a finalized
    // artifact, not to a transfer that still has to be verified, renamed and
    // re-verified. `acquireClearHlsTs` emits it once all of that has succeeded.
    if (completed < plan.fragmentCount) {
      reportSafely(onProgress, completed, aggregateBytes, plan.fragmentCount);
    }
  }
  return aggregateBytes;
}

/**
 * One truthful report. Never emitted for a fragment that did not complete, and
 * never at 100 for an acquisition that has not committed its artifact.
 *
 * Progress is an OBSERVATION channel, never transport authority. `onProgress`
 * is caller-supplied synchronous code, and a caller-side defect in it must not
 * decide whether media was acquired: a reporter that throws would otherwise
 * abort a transfer that was going fine, or — worse, once 100 is reserved for a
 * finalized artifact — delete an artifact that had already been verified and
 * turn a reported success into a failure.
 *
 * So the exception is dropped WHOLE. It is not propagated, not attached as a
 * cause, not logged, and not mapped onto the failure vocabulary: it is the
 * caller's own error and its text could name anything, including a host or a
 * path this module is forbidden to surface.
 *
 * This is not a cancellation channel either. A caller that wants to stop the
 * acquisition aborts the `AbortSignal` it supplied; that still takes effect at
 * the next stop boundary, and swallowing the reporter's exception neither
 * swallows nor undoes it.
 */
function reportSafely(
  onProgress: ClearHlsAcquisitionRequest["onProgress"],
  completed: number,
  aggregateBytes: number,
  fragmentCount: number,
): void {
  if (onProgress === undefined) return;
  try {
    onProgress({
      progress: Math.min(100, Math.round((completed / fragmentCount) * 100)),
      downloadedBytes: aggregateBytes,
      totalBytes: null,
      speed: null,
      eta: null,
      stage: "downloading",
    });
  } catch {
    // Best-effort observer output. The caller's exception is dropped whole.
  }
}

// ── Budget and stop causes ───────────────────────────────────────────────────

type StopCause = "cancelled" | "timeout";

/**
 * The ONE total budget for the whole acquisition: every DNS lookup, connect,
 * redirect hop, response body and the finalization share it, and no fragment
 * gets a fresh one.
 *
 * It defaults to, and is capped at, the existing download budget. A budget that
 * is not a positive number is a deadline that has already passed, so nothing
 * starts.
 */
function acquisitionBudgetMs(requested: number | undefined): number | null {
  const ceiling = config.downloadTimeoutMs;
  const budget = requested === undefined ? ceiling : Math.min(requested, ceiling);
  return Number.isFinite(budget) && budget > 0 ? budget : null;
}

// ── The finalization barrier ─────────────────────────────────────────────────

/**
 * The points inside finalization where a stop may land: while the final
 * no-clobber check is in flight, while the rename is in flight, and while the
 * final size verification is in flight.
 */
export type FinalizationStep = "before-rename" | "after-rename" | "before-return";

/**
 * A test-only barrier, inert in Production.
 *
 * Finalization is three short filesystem awaits, and a cancellation or a
 * deadline landing inside any of them must still stop the acquisition. Proving
 * that with wall-clock timing would be luck rather than a test, so this module
 * offers the smallest seam that makes it deterministic: a module-private hook a
 * test can use to hold one await open, stop the acquisition, and release it.
 *
 * It is not a production abstraction. Nothing in Production imports this module
 * at all, so no production caller can reach the setter, and while the barrier
 * is null the finalization path is byte-for-byte what it would be without the
 * seam.
 */
let finalizationBarrier: ((step: FinalizationStep) => Promise<void>) | null = null;

/** Install or clear the barrier. Passing null restores the production path. */
export function setClearHlsFinalizationBarrierForTests(
  barrier: ((step: FinalizationStep) => Promise<void>) | null,
): void {
  finalizationBarrier = barrier;
}

/** Nothing at all unless a test installed a barrier. */
function atFinalizationStep(step: FinalizationStep): Promise<void> | void {
  if (finalizationBarrier === null) return;
  return finalizationBarrier(step);
}

// ── The acquisition ──────────────────────────────────────────────────────────

/**
 * Download one approved plan's MPEG-TS fragments into one local aggregate.
 * Throws `ClearHlsAcquisitionError` otherwise; there is no partial success.
 *
 * Lifecycle:
 *
 *   1. structurally validate the plan, before ANY I/O;
 *   2. resolve the two fixed output paths and require both to be absent;
 *   3. create the partial exclusively (`wx`, 0o600), so a pre-existing
 *      artifact fails closed instead of being silently overwritten;
 *   4. download and append every fragment, sequentially;
 *   5. verify the open handle's size equals the streamed counter, then close;
 *   6. require the operation not to have been stopped;
 *   7. rename the partial onto the aggregate name and verify its size, with a
 *      stop gate after every one of those awaits;
 *   8. COMMIT — disarm the deadline and the caller-abort listener, build the
 *      result, emit the terminal 100 report and return.
 *
 * On ANY failure before finalization the partial is removed, and on a failure
 * after finalization the aggregate is removed too: a failed call never leaves a
 * successful-looking artifact behind.
 *
 * Deadline and cancellation: ONE operation-owned controller carries whichever
 * stop cause arrives FIRST — the caller's cancellation or the acquisition
 * deadline — into `safeGet()`, into every response body, and into the loop. The
 * first cause is latched, so a later failure caused by the stop cannot
 * overwrite it, and the caller's own `AbortSignal.reason` is never read or
 * surfaced. The deadline is armed once, before the first fragment, and nothing
 * re-arms it.
 *
 * That one deadline covers finalization as well as transfer. Every await in
 * steps 5 to 8 is followed by a stop gate, so an acquisition whose caller
 * cancelled, or whose deadline expired, while the no-clobber check, the rename
 * or the final `stat` was in flight cannot still return success: it is
 * classified as the latched first cause, and the artifact it had already
 * created — partial or final — is removed. The last gate is the last
 * asynchronous thing the function does; only the synchronous terminal report
 * and the frozen result follow it.
 *
 * That gate is also the COMMIT POINT. Past it the acquisition detaches from
 * its stop sources and nothing can turn the finished artifact back into a
 * failure — not a late abort, not an expired timer, and not the terminal
 * progress callback, which is observer-only and whose exceptions are dropped.
 * Between the commit point and the return there is no await, no filesystem
 * operation, no network operation and nothing else that can fail. The
 * invariant this buys is exact: an acquisition that rejects never reported
 * 100, and a reported 100 always means a committed artifact that remains on
 * disk.
 *
 * Unlike HLS-2, this function does not race its deadline against the work it
 * started: it owns an open file, and returning while the transfer loop was
 * still appending would mean unlinking a partial another loop still held. Every
 * await it performs is instead abort-responsive — `safeGet()` refuses to begin
 * a hop, resolve a destination or build a request once the signal has aborted,
 * each response body is destroyed by the abort listener, and the loop re-checks
 * between fragments. The one operation that cannot be interrupted is an
 * operating-system lookup already in flight, since `dns.promises.lookup` takes
 * no signal; the acquisition may therefore return slightly after its deadline
 * while such a lookup unwinds. That is bounded rather than open-ended, because
 * safe-HTTP re-checks the abort signal after destination resolution and before
 * a request is built: a late answer produces no request object, no socket and
 * no request byte. Cancelling DNS itself is not claimed.
 */
export async function acquireClearHlsTs(
  request: ClearHlsAcquisitionRequest,
): Promise<ClearHlsAcquiredTs> {
  const { plan, workDir, signal, timeoutMs, onProgress } = request;

  // Nothing starts for a caller that has already gone: no plan work, no
  // lookup, no request and no file.
  if (signal.aborted) throw new ClearHlsAcquisitionError("cancelled");
  if (!isApprovedPlan(plan)) throw new ClearHlsAcquisitionError("invalid_plan");

  const paths = acquisitionPaths(workDir);
  if (paths === null) throw new ClearHlsAcquisitionError("output_error");

  const budgetMs = acquisitionBudgetMs(timeoutMs);
  if (budgetMs === null) throw new ClearHlsAcquisitionError("timeout");

  let stopped: StopCause | null = null;
  const controller = new AbortController();
  const stop = (cause: StopCause) => {
    if (stopped !== null) return;
    stopped = cause;
    controller.abort();
  };
  const onCallerAbort = () => stop("cancelled");
  signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), budgetMs);

  /**
   * Detach this acquisition from everything that could still stop it.
   *
   * Idempotent on purpose: it runs once at the commit point and again in the
   * `finally`, and both `clearTimeout` on a cleared timer and
   * `removeEventListener` for a listener that is already gone are no-ops.
   */
  const disarmStopSources = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
  };

  /**
   * Map anything thrown onto the closed vocabulary. The original error is
   * DROPPED, never wrapped: its message could name a host or a path.
   *
   * Once the caller or the deadline has stopped the acquisition, whatever the
   * interrupted operation reported afterwards is a consequence, not the cause,
   * so the latched first cause wins.
   */
  const classify = (err: unknown): ClearHlsAcquisitionError => {
    if (stopped !== null) return new ClearHlsAcquisitionError(stopped);
    if (err instanceof ClearHlsAcquisitionError) return err;
    if (err instanceof AppError) {
      if (err.code === "INVALID_URL") return new ClearHlsAcquisitionError("destination_rejected");
      if (err.code === "TIMEOUT") return new ClearHlsAcquisitionError("timeout");
    }
    return new ClearHlsAcquisitionError("network_error");
  };

  // Only an artifact THIS call created may be removed by it. A pre-existing
  // partial or aggregate belongs to whatever put it there and is left exactly
  // as found.
  let owned: string | null = null;
  try {
    if (await exists(paths.aggregatePath)) refuse("output_error");
    if (await exists(paths.partialPath)) refuse("output_error");

    let handle: FileHandle;
    try {
      handle = await open(paths.partialPath, "wx", 0o600);
    } catch {
      refuse("output_error");
    }
    owned = paths.partialPath;

    let aggregateBytes: number;
    try {
      aggregateBytes = await transferFragments(
        plan,
        handle,
        controller.signal,
        budgetMs,
        onProgress,
      );
      let written: number;
      try {
        written = (await handle.stat()).size;
      } catch {
        refuse("output_error");
      }
      if (written !== aggregateBytes) refuse("output_error");
    } finally {
      await closeQuietly(handle);
    }

    // Finalize only for an acquisition that was never stopped.
    controller.signal.throwIfAborted();
    // A private single-flight workDir, so this immediate no-clobber check is
    // the whole guarantee: it is not a claim of resistance against another
    // process racing the rename on a hostile filesystem.
    if (await exists(paths.aggregatePath)) refuse("output_error");

    // A stop that landed while that check was in flight must not let the
    // rename begin.
    await atFinalizationStep("before-rename");
    controller.signal.throwIfAborted();
    try {
      await rename(paths.partialPath, paths.aggregatePath);
    } catch {
      refuse("output_error");
    }
    // The aggregate belongs to this call from the instant the rename succeeds,
    // so a stop arriving from here on removes it rather than leaving a
    // successful-looking artifact behind for an acquisition that failed.
    owned = paths.aggregatePath;
    await atFinalizationStep("after-rename");
    controller.signal.throwIfAborted();

    let fileSize: number;
    try {
      fileSize = (await stat(paths.aggregatePath)).size;
    } catch {
      refuse("output_error");
    }
    if (fileSize !== aggregateBytes) refuse("output_error");

    // The LAST await of the acquisition, and the last gate. Nothing
    // asynchronous may follow it: the terminal report and the result are
    // synchronous, so no stop can land between this check and the return.
    await atFinalizationStep("before-return");
    controller.signal.throwIfAborted();

    // ── THE COMMIT POINT ────────────────────────────────────────────────────
    //
    // Everything that defines a successful acquisition has now happened: all
    // fragment bytes were transferred, the source size was verified against
    // the streamed counter, the partial was closed, the no-clobber check
    // passed, the rename completed, the final artifact became this call's, its
    // size was verified, and the final stop gate passed. From here the media
    // acquisition is COMMITTED and nothing may undo it.
    //
    // So the acquisition detaches from its external stop sources first. A
    // synchronous terminal report is post-commit code: a caller that aborts
    // its signal from inside that callback is cancelling an operation that has
    // already finished, and must not retroactively delete a verified artifact.
    // This changes nothing before this line — cancellation and the deadline
    // are fully authoritative right up to the gate above.
    disarmStopSources();

    // Built BEFORE the observer runs, so the result cannot depend on it.
    const result = Object.freeze({
      filePath: paths.aggregatePath,
      segmentType: "mpegts" as const,
      fileSize,
    });

    // 100 means exactly one thing: a finalized, verified, committed artifact.
    // Observer-only — a reporter that throws cannot take it back.
    reportSafely(onProgress, plan.fragmentCount, aggregateBytes, plan.fragmentCount);
    return result;
  } catch (err) {
    const failure = classify(err);
    if (owned !== null) await removeQuietly(owned);
    throw failure;
  } finally {
    disarmStopSources();
    controller.abort();
  }
}
