import { stat as fsStat, readdir as fsReaddir, lstat as fsLstat, realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { AppError } from "../../lib/errors.ts";
import { assertSafeUrl } from "../../lib/security/ssrf.server.ts";
import {
  ProcessOutputLimitError,
  runProcess,
  type RunResult,
} from "../../services/processing/process-runner.server.ts";
import {
  YTDLP_PROBE_TIMEOUT_MS,
  YTDLP_RUNTIME,
  buildYtdlpEnvironment,
  probeYtdlpRuntime,
  ytdlpPolicyArgs,
  type YtdlpProbeOptions,
  type YtdlpRuntimeStatus,
} from "../runtime/ytdlp-runtime.server.ts";
import { buildGenericFormatSelector, type GenericSourceSelection } from "./generic-source.ts";
import {
  GenericExecutionPlanSchema,
  type GenericExecutionPlan,
  type GenericSingleSourceExecutionPlan,
  type GenericSplitExecutionPlan,
} from "./format-plan.ts";

/**
 * Worker-owned GENERIC ORIGINAL ACQUISITION (Phase 10C3 §20), and — since
 * SPLIT-03 — the DUAL-SOURCE acquisition of one approved split pair.
 *
 * Two primitives, deliberately distinct in contract and in type:
 *
 *   `downloadGenericOriginal`      one single-source plan -> exactly ONE local
 *                                  original source artifact;
 *   `downloadGenericSplitSources`  one `merge-split` plan -> exactly TWO local
 *                                  source artifacts, the pair's video-only and
 *                                  audio-only members, acquired SEQUENTIALLY
 *                                  as two independent single-source runs under
 *                                  one deadline and one combined byte budget.
 *
 * Both are the network half of generic execution and nothing else. The split
 * merge itself is SPLIT-02's `mergeSplitMedia`, which only the executor may
 * reach, after `beginProcessing()` commits — never this module.
 *
 * ─── The lifecycle boundary this module protects ────────────────────────────
 *
 *     downloading = network acquisition ONLY
 *     processing  = Worker-owned local FFmpeg ONLY
 *
 * Everything in this file exists to keep yt-dlp from performing local media
 * work while the durable job still says `downloading`. That is enforced by five
 * independent mechanisms, no one of which is trusted alone (§24):
 *
 *   1. `--downloader=native`, inherited from the closed base policy, so
 *      acquisition uses `HttpFD`;
 *   2. a single progressive http/https source PER SUBPROCESS — a split pair is
 *      two runs, never one `+`-joined selection — so no fragment or manifest
 *      downloader is reachable and no merge is possible;
 *   3. a PATH that resolves nothing, so `ffmpeg`/`ffprobe` cannot be found by
 *      bare name;
 *   4. `--ffmpeg-location` pointed at a fixed nonexistent path, which makes the
 *      pinned release treat FFmpeg as unavailable outright;
 *   5. `--fixup=never`, so no post-download media repair is attempted even if
 *      something were available.
 *
 * ─── What this module must never do ─────────────────────────────────────────
 *
 * No FFmpeg work, no transcode, no remux, no stream merge, no audio extraction,
 * no format re-selection, and never more than one returned file per approved
 * source. Audio extraction and MP3 transcoding — and, once integrated, the
 * split merge — are the JobExecutor's, performed with the Worker's own FFmpeg
 * strictly after `beginProcessing()` commits.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on the acquisition subprocess's stdout.
 *
 * Far smaller than the analysis ceiling because the command is `--quiet` and
 * `--no-progress` and NO document is expected: a correct run prints essentially
 * nothing. 64 KiB is generous for the stray line a future release might emit
 * while still bounding a malfunctioning extractor tightly.
 */
export const YTDLP_DOWNLOAD_MAX_STDOUT_BYTES = 64 * 1024;

/**
 * Hard ceiling on the acquisition subprocess's stderr.
 *
 * stderr is read only to classify a failure into a canonical code. 128 KiB
 * accommodates a multi-line traceback; overflow is itself a failure.
 */
export const YTDLP_DOWNLOAD_MAX_STDERR_BYTES = 128 * 1024;

/**
 * Polling interval for the actual-byte size guard (§31).
 *
 * The Worker runs ONE job at a time (`WORKER_MAX_CONCURRENT_JOBS = 1`), so a
 * single timer at this cadence is negligible. 150 ms bounds the overshoot past
 * the limit to roughly one interval's worth of transfer while staying far away
 * from a busy loop.
 */
export const YTDLP_DOWNLOAD_SIZE_POLL_MS = 150;

/** Bounded network behaviour, mirroring the analysis policy's intent. */
const DOWNLOAD_SOCKET_TIMEOUT_SECONDS = 10;
const DOWNLOAD_RETRIES = 2;
const DOWNLOAD_FRAGMENT_RETRIES = 1;
const DOWNLOAD_EXTRACTOR_RETRIES = 1;

/** Floor on the acquisition budget, mirroring the analysis floor. */
export const YTDLP_DOWNLOAD_MIN_TIMEOUT_MS = 1_000;

// ── Descendant isolation (§21) ───────────────────────────────────────────────

/**
 * PATH for the acquisition child. It resolves nothing.
 *
 * Same reasoning as the analysis PATH, and it matters MORE here: this child is
 * the one actually holding media bytes, so a discoverable `/usr/bin/ffmpeg`
 * would be a working local toolchain attached to a process running while the
 * durable job says `downloading`.
 *
 * Deliberately a nonexistent ABSOLUTE path rather than an empty string: an
 * empty PATH is interpreted by some resolvers as "use the system default"
 * (`confstr(_CS_PATH)` → `/bin:/usr/bin`), silently restoring what this removes.
 */
export const YTDLP_DOWNLOAD_PATH = "/nonexistent/videofetch-yt-dlp-no-path";

/**
 * A fixed, nonexistent location handed to `--ffmpeg-location`.
 *
 * Verified against yt-dlp 2026.08.19's `FFmpegPostProcessor._determine_executables`:
 * leaving the option UNSET is an active grant of PATH discovery
 * (`return {p: p for p in programs}`), whereas a nonexistent location warns and
 * returns an EMPTY executable map. With `_paths` empty, `_get_ffmpeg_version`
 * short-circuits to `(None, {})`, so `available` and `probe_available` are both
 * False and `FFmpegFD.available()` — which delegates straight to
 * `FFmpegPostProcessor().available` — is False too.
 *
 * A compile-time constant: never read from the request, environment or
 * configuration, so no caller and no user can point it at a real binary.
 */
export const YTDLP_DOWNLOAD_FFMPEG_LOCATION = "/nonexistent/videofetch-yt-dlp-no-ffmpeg";

/** The fixed, server-owned output template (§28). */
export const YTDLP_DOWNLOAD_OUTPUT_BASENAME = "source";

/**
 * SPLIT-03: the fixed, server-owned output basenames of a split pair's halves.
 *
 * One per ROLE, never shared, and both distinct from the single-source
 * `source`. A valid WebM pair has TWO `.webm` sources, so the extension alone
 * cannot keep the halves apart — the basename must. Like `source`, neither is
 * derived from anything upstream- or browser-controlled; the only
 * interpolation in either template remains `%(ext)s`.
 */
export const YTDLP_SPLIT_OUTPUT_BASENAMES = Object.freeze({
  video: "video-source",
  audio: "audio-source",
} as const);

/** Which half of an approved split pair one acquisition run fetches. */
export type GenericSplitRole = keyof typeof YTDLP_SPLIT_OUTPUT_BASENAMES;

/**
 * The COMPLETE environment for an acquisition subprocess.
 *
 * The Phase-10C1 closed allowlist with PATH replaced by a location that
 * resolves nothing. `HOME`/`TMPDIR`/XDG roots point at the job's own workDir, so
 * even a future release consulting them finds nothing an operator or attacker
 * placed there.
 */
export function buildYtdlpDownloadEnvironment(opts: { workDir: string }): NodeJS.ProcessEnv {
  return Object.freeze({
    ...buildYtdlpEnvironment({ workDir: opts.workDir }),
    PATH: YTDLP_DOWNLOAD_PATH,
  }) as NodeJS.ProcessEnv;
}

// ── Argument policy (§23) ────────────────────────────────────────────────────

/**
 * The acquisition-specific argument policy, applied ON TOP of the closed
 * Phase-10C1 base policy.
 *
 * Every option is verified against yt-dlp 2026.08.19's own `options.py`:
 *
 *   --no-cache-dir         `'--no-cache-dir'`      -> cachedir=False
 *   --quiet                `'-q', '--quiet'`
 *   --no-progress          `'--no-progress'`
 *   --no-warnings          `'--no-warnings'`
 *   --socket-timeout       `'--socket-timeout'`, float
 *   --retries              `'-R', '--retries'`
 *   --fragment-retries     `'--fragment-retries'`
 *   --extractor-retries    `'--extractor-retries'`
 *   --ffmpeg-location      `'--ffmpeg-location'`
 *   --fixup                `'--fixup'`, choices ('never','ignore','warn','detect_or_warn','force')
 *   --max-filesize         `'--max-filesize'`
 *   --concurrent-fragments `'-N', '--concurrent-fragments'`
 *   --no-keep-fragments    `'--no-keep-fragments'`
 *   --no-mtime             `'--no-mtime'`
 *   --no-overwrites        `'-w', '--no-overwrites'`
 *   --format               `'-f', '--format'`
 *   --output               `'-o', '--output'`
 *
 * Deliberately ABSENT, and asserted absent by tests (§24): `-x`,
 * `--extract-audio`, `--audio-format`, `--merge-output-format`, `--remux-video`,
 * `--recode-video`, `--download-sections`, `--exec`, `--exec-before-download`,
 * `--downloader-args`, `--external-downloader`, `--external-downloader-args`,
 * every `--write-*` side file, `--load-info-json`, `--wait-for-video`, and
 * output to stdout.
 *
 * `--no-part` is deliberately NOT passed. Keeping yt-dlp's default `.part`
 * behaviour is what gives the actual-byte guard a predictable path to watch
 * while bytes are still arriving (§30).
 */
export function ytdlpDownloadPolicyArgs(opts: {
  readonly formatSelector: string;
  readonly outputTemplate: string;
  readonly maxFileSizeBytes: number;
}): readonly string[] {
  return Object.freeze([
    // ── no filesystem residue ────────────────────────────────────────────
    "--no-cache-dir",

    // ── quiet streams ────────────────────────────────────────────────────
    // Nothing parses these; they exist only for failure classification, and a
    // silent run keeps the bounded buffers empty.
    "--quiet",
    "--no-progress",
    "--no-warnings",

    // ── bounded network behaviour ────────────────────────────────────────
    `--socket-timeout=${DOWNLOAD_SOCKET_TIMEOUT_SECONDS}`,
    `--retries=${DOWNLOAD_RETRIES}`,
    `--fragment-retries=${DOWNLOAD_FRAGMENT_RETRIES}`,
    `--extractor-retries=${DOWNLOAD_EXTRACTOR_RETRIES}`,

    // ── FFmpeg denial ────────────────────────────────────────────────────
    `--ffmpeg-location=${YTDLP_DOWNLOAD_FFMPEG_LOCATION}`,

    // ── postprocessing denial ────────────────────────────────────────────
    // Defence in depth beyond "FFmpeg is unavailable": this removes the fixup
    // BEHAVIOUR rather than relying on its tool being missing (§22).
    "--fixup=never",

    // ── size bound, defence in depth ─────────────────────────────────────
    // Effective only when the server declares a Content-Length: the pinned
    // `HttpFD.real_download` checks `max_filesize` inside `if data_len is not
    // None`. An unknown or decompressed length keeps streaming, which is
    // exactly why this is NOT sufficient and the actual-byte guard exists.
    `--max-filesize=${maxFileSizeArg(opts.maxFileSizeBytes)}`,

    // ── fragment policy ──────────────────────────────────────────────────
    // A progressive http/https source should never fragment. Both options are
    // stated anyway so a future source shape cannot quietly gain parallel
    // fragment downloads or leave fragment files behind.
    "--concurrent-fragments=1",
    "--no-keep-fragments",

    // ── filesystem hygiene ───────────────────────────────────────────────
    // No upstream mtime is applied, and an existing file is never silently
    // reused as if it had just been downloaded.
    "--no-mtime",
    "--no-overwrites",

    // ── the single approved source ───────────────────────────────────────
    `--format=${opts.formatSelector}`,

    // ── fixed, server-owned destination ──────────────────────────────────
    `--output=${opts.outputTemplate}`,
  ] as const);
}

/** `--max-filesize` takes a plain byte count here; no unit suffix is used. */
function maxFileSizeArg(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  return String(bytes);
}

/**
 * The COMPLETE argv for one acquisition run.
 *
 * The URL is the sole free-form element and is always the final positional
 * argument, after a bare `--`. Both `optparse` and yt-dlp's own
 * `parse_known_args` override stop option processing at `--`, so a URL
 * beginning with `-` is a URL and cannot be read as an option or its value.
 */
export function buildYtdlpDownloadArgv(opts: {
  readonly validatedUrl: string;
  readonly workDir: string;
  /**
   * SPLIT-01: a SINGLE-source plan only. `merge-split` names two upstream
   * sources and has no single `source` to bind, so it is excluded by type
   * rather than by a runtime check that a future edit could drop.
   */
  readonly plan: GenericSingleSourceExecutionPlan;
  readonly maxFileSizeBytes: number;
}): readonly string[] {
  return buildAcquisitionArgv({
    validatedUrl: opts.validatedUrl,
    source: opts.plan.source,
    outputTemplate: outputTemplateFor(opts.workDir),
    maxFileSizeBytes: opts.maxFileSizeBytes,
  });
}

/**
 * SPLIT-03: the COMPLETE argv for ONE half of an approved split pair.
 *
 * `role` selects BOTH the pair member AND the output basename, so the video
 * member's selector can only ever write `video-source.*` and the audio
 * member's only `audio-source.*` — a binding made here, structurally, rather
 * than by two independent arguments a caller could cross.
 *
 * Exactly ONE source per invocation. The selector is that member's own
 * complete `buildGenericFormatSelector` expression; the two members are never
 * joined into a `video+audio` yt-dlp selection, which would hand yt-dlp the
 * choice of sources AND its own FFmpeg merge while the durable job still says
 * `downloading`.
 */
export function buildYtdlpSplitDownloadArgv(opts: {
  readonly validatedUrl: string;
  readonly workDir: string;
  /** A `merge-split` plan only; the single-source builder excludes it by type. */
  readonly plan: GenericSplitExecutionPlan;
  readonly role: GenericSplitRole;
  /** This half's allowance: the combined budget minus bytes already acquired. */
  readonly maxFileSizeBytes: number;
}): readonly string[] {
  return buildAcquisitionArgv({
    validatedUrl: opts.validatedUrl,
    source: opts.plan.pair[opts.role],
    outputTemplate: splitOutputTemplateFor(opts.workDir, opts.role),
    maxFileSizeBytes: opts.maxFileSizeBytes,
  });
}

/**
 * The one place an acquisition command is assembled: ONE approved source, the
 * closed base policy, the closed acquisition policy, a fixed output template,
 * and the URL last.
 *
 * Private, and shared by both public builders, so the single-source run and
 * each half of a split pair cannot drift onto different policies. It takes a
 * single source selection; there is no parameter through which a second
 * source, a selector string or a raw yt-dlp argument could arrive.
 */
function buildAcquisitionArgv(opts: {
  readonly validatedUrl: string;
  readonly source: GenericSourceSelection;
  readonly outputTemplate: string;
  readonly maxFileSizeBytes: number;
}): readonly string[] {
  return Object.freeze([
    YTDLP_RUNTIME.artifactPath,
    ...ytdlpPolicyArgs(),
    ...ytdlpDownloadPolicyArgs({
      formatSelector: buildGenericFormatSelector(opts.source),
      outputTemplate: opts.outputTemplate,
      maxFileSizeBytes: opts.maxFileSizeBytes,
    }),
    "--",
    opts.validatedUrl,
  ]);
}

/**
 * The fixed output template (§28).
 *
 * `%(ext)s` is the ONLY interpolation, and the acquired extension is then
 * required to equal the container the plan approved. No title, id, format id,
 * uploader or other extractor-controlled field can influence the path, so no
 * upstream string ever becomes a filename component.
 */
export function outputTemplateFor(workDir: string): string {
  return join(workDir, `${YTDLP_DOWNLOAD_OUTPUT_BASENAME}.%(ext)s`);
}

/** The exact final path a correct run must produce. */
export function expectedSourcePath(workDir: string, container: string): string {
  return join(workDir, `${YTDLP_DOWNLOAD_OUTPUT_BASENAME}.${container}`);
}

/** The `.part` path yt-dlp streams into before renaming. */
export function expectedPartPath(workDir: string, container: string): string {
  return `${expectedSourcePath(workDir, container)}.part`;
}

/**
 * SPLIT-03: the fixed output template for ONE half of a split pair.
 *
 * Same rule as `outputTemplateFor`: `%(ext)s` is the only interpolation, and
 * the acquired extension must then equal that member's approved container.
 */
export function splitOutputTemplateFor(workDir: string, role: GenericSplitRole): string {
  return join(workDir, `${YTDLP_SPLIT_OUTPUT_BASENAMES[role]}.%(ext)s`);
}

/** SPLIT-03: the exact final path one half of a pair must produce. */
export function expectedSplitSourcePath(
  workDir: string,
  role: GenericSplitRole,
  container: string,
): string {
  return join(workDir, `${YTDLP_SPLIT_OUTPUT_BASENAMES[role]}.${container}`);
}

/** SPLIT-03: the `.part` path that half streams into before renaming. */
export function expectedSplitPartPath(
  workDir: string,
  role: GenericSplitRole,
  container: string,
): string {
  return `${expectedSplitSourcePath(workDir, role, container)}.part`;
}

// ── Error classification (§34) ───────────────────────────────────────────────

/**
 * Maps a failed acquisition to a canonical Worker error code.
 *
 * Same narrow contract as the analysis classifier: raw text goes IN, a
 * canonical code comes OUT, and the text is never stored, logged or attached to
 * the returned error. Anything unrecognized collapses to `EXTRACTION_FAILED`.
 */
export function classifyDownloadFailure(raw: string): AppError["code"] {
  const text = raw.toLowerCase();

  // Checked FIRST: a size refusal is more specific than the generic format and
  // network phrases that may accompany it.
  if (text.includes("larger than max-filesize") || text.includes("file is too large")) {
    return "TOO_LARGE";
  }
  if (
    text.includes("requested format is not available") ||
    text.includes("requested format not available") ||
    text.includes("no video formats found")
  ) {
    return "FORMAT_UNAVAILABLE";
  }
  if (
    text.includes("private video") ||
    text.includes("video unavailable") ||
    text.includes("has been removed") ||
    text.includes("sign in") ||
    text.includes("login required") ||
    text.includes("members-only") ||
    text.includes("age-restricted") ||
    text.includes("this video is not available")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    text.includes("unable to download") ||
    text.includes("connection refused") ||
    text.includes("connection reset") ||
    text.includes("temporary failure in name resolution") ||
    text.includes("network is unreachable")
  ) {
    return "NETWORK_ERROR";
  }
  return "EXTRACTION_FAILED";
}

// ── Public shapes ────────────────────────────────────────────────────────────

/**
 * What caused this acquisition's abort, if anything.
 *
 * One-way: whoever writes it first owns the interpretation for the rest of the
 * call. `caller` covers user cancellation and operator shutdown alike — both
 * arrive through the caller's signal — while `overflow` is this module's own
 * byte guard.
 */
type AbortCause = "caller" | "overflow" | null;

export type GenericDownloadLimits = {
  /**
   * The acquisition byte ceiling. For a split pair it is ONE COMBINED budget —
   * video bytes plus audio bytes together — never a separate allowance per half.
   */
  readonly maxFileSizeBytes: number;
  /** ONE subprocess budget for the whole call, the runtime probe included. */
  readonly downloadTimeoutSeconds: number;
};

export type GenericDownloadProgress = {
  readonly progress: number | null;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly speed: number | null;
  readonly eta: number | null;
  readonly stage: string;
};

export type GenericOriginalDownload = {
  /** Canonical absolute path of the single acquired artifact. */
  readonly filePath: string;
  /** The approved source container; equals the file's real extension. */
  readonly container: string;
  readonly fileSize: number;
};

/**
 * SPLIT-03: one validated LOCAL split-source artifact.
 *
 * Deliberately the same three fields as a single-source result. No upstream
 * format id, selector, argv, source URL or codec string crosses the function
 * boundary: those stay inside the private plan.
 */
export type GenericSplitSourceArtifact = {
  /** Absolute path of the artifact, proven physically inside the workDir. */
  readonly filePath: string;
  /** That member's approved source container; equals the real extension. */
  readonly container: string;
  readonly fileSize: number;
};

/** SPLIT-03: the two acquired halves of one approved split pair. */
export type GenericSplitSourcesDownload = {
  readonly video: GenericSplitSourceArtifact;
  readonly audio: GenericSplitSourceArtifact;
  /** `video.fileSize + audio.fileSize`, proven within the combined budget. */
  readonly totalFileSize: number;
};

export type GenericDownloadDeps = {
  readonly limits: GenericDownloadLimits;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: GenericDownloadProgress) => void;
  /** Test seams. Production uses the real hardened runner, probe, clock and fs. */
  readonly runner?: typeof runProcess;
  readonly probeRuntime?: (opts: YtdlpProbeOptions) => Promise<YtdlpRuntimeStatus>;
  readonly validateUrl?: (raw: string) => Promise<{ url: string; hostname: string }>;
  readonly clock?: () => number;
  readonly statSize?: (path: string) => Promise<number | null>;
  readonly readDir?: (path: string) => Promise<string[]>;
  readonly sizePollMs?: number;
};

/** Default size probe: absent file is `null`, never an error. */
async function defaultStatSize(path: string): Promise<number | null> {
  try {
    const s = await fsStat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

// ── The downloader ───────────────────────────────────────────────────────────

/**
 * Acquires the ONE original source described by a generic execution plan.
 *
 * Order of operations is a security property, not a style choice:
 *
 *   1. re-validate the plan;
 *   2. re-validate the submitted URL (§25);
 *   3. verify the EXACT pinned runtime (§26);
 *   4. only then start a network-capable subprocess.
 *
 * Steps 1 and 2 complete before ANY process is spawned — the version probe
 * included — so an unsafe or malformed URL causes zero yt-dlp processes and no
 * DNS or TCP activity attributable to it. The URL is re-checked even though
 * analysis already validated it, because analysis-time DNS state is not
 * download-time DNS state.
 *
 * The initial check is defence in depth and NOT a claim about yt-dlp's own
 * networking: once running, yt-dlp issues its own secondary requests and follows
 * its own redirects. Those are constrained in Production by the external media
 * network namespace, its nftables policy and the watchdog.
 */
export async function downloadGenericOriginal(
  url: string,
  workDir: string,
  plan: GenericExecutionPlan,
  deps: GenericDownloadDeps,
): Promise<GenericOriginalDownload> {
  const runner = deps.runner ?? runProcess;
  const probe = deps.probeRuntime ?? probeYtdlpRuntime;
  const validate = deps.validateUrl ?? assertSafeUrl;
  const clock = deps.clock ?? Date.now;
  const statSize = deps.statSize ?? defaultStatSize;
  const readDir = deps.readDir ?? ((p: string) => fsReaddir(p));
  const pollMs = deps.sizePollMs ?? YTDLP_DOWNLOAD_SIZE_POLL_MS;

  // 1. The plan is re-parsed rather than trusted: it crossed a module boundary,
  //    and it is what builds the format selector.
  const checkedPlan = GenericExecutionPlanSchema.safeParse(plan);
  if (!checkedPlan.success) throw new AppError("FORMAT_UNAVAILABLE");

  // SPLIT-01: this primitive acquires exactly ONE source, and says so. A
  // `merge-split` plan names two, so it is REFUSED here rather than partially
  // honoured — acquiring only the video half would hand the executor a silently
  // audio-less artifact, which is precisely the substitution §17 forbids.
  //
  // Unreachable today: no analysis path builds a split preset source, so
  // `deriveGenericExecutionPlan` cannot produce this operation. The refusal is
  // the type narrowing AND the guarantee: `downloadGenericSplitSources` is the
  // ONLY acquisition API that consumes a pair, so a pair routed here by mistake
  // fails closed instead of downloading half a video.
  if (checkedPlan.data.operation === "merge-split") {
    throw new AppError("FORMAT_UNAVAILABLE");
  }
  const validPlan = checkedPlan.data;

  if (!isAbsolute(workDir)) throw new AppError("PROCESSING_FAILED");
  const maxBytes = deps.limits.maxFileSizeBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }

  // 2. The Worker's own URL/SSRF validation, before anything is spawned. Its
  //    AppErrors (INVALID_URL, NETWORK_ERROR) propagate unchanged.
  const { url: safeUrl } = await validate(url);

  // An already-cancelled caller gets no subprocess at all — not even the probe.
  if (deps.signal?.aborted) {
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  }

  // 3. ONE deadline for the WHOLE subprocess phase (§26). The probe and the
  //    acquisition SHARE it: giving the network run a fresh full budget after
  //    the probe already spent part of one would let the pair take up to twice
  //    what the configuration permits.
  const deadline = clock() + acquisitionBudgetMs(deps.limits);

  const probeBudgetMs = Math.min(YTDLP_PROBE_TIMEOUT_MS, deadline - clock());
  if (probeBudgetMs <= 0) throw new AppError("TIMEOUT");

  const runtime = await probe({ signal: deps.signal, timeoutMs: probeBudgetMs });
  if (!runtime.available) throw new AppError("EXTRACTOR_UNAVAILABLE");

  const networkTimeoutMs = deadline - clock();
  if (networkTimeoutMs <= 0) throw new AppError("TIMEOUT");

  const container = validPlan.source.container;
  const finalPath = expectedSourcePath(workDir, container);
  const partPath = expectedPartPath(workDir, container);

  // ── the actual-byte guard (§30) ──────────────────────────────────────────
  //
  // `--max-filesize` is defence in depth only. This is the enforcement: it
  // watches the bytes that actually landed, so an unknown or misdeclared
  // Content-Length cannot stream past the limit.
  //
  // The controller is OWNED here and linked to the caller's signal, so one
  // abort path reaches the process group whether the trigger was the user, a
  // shutdown, or this guard.
  const controller = new AbortController();

  // ── first-cause abort latch (CORRECTION-01 §11) ──────────────────────────
  //
  // A plain `overflowed` boolean was not enough: a sample that finished LATER
  // could set it after the caller had already cancelled, silently rewriting a
  // user cancellation as a size refusal. Cause is therefore recorded ONCE, by
  // whoever aborts first, and is never mutated afterwards.
  //
  // Both orderings are covered: caller-then-overflow stays a cancellation, and
  // overflow-then-caller stays TOO_LARGE.
  let abortCause: AbortCause = null;
  const abortOnce = (cause: NonNullable<AbortCause>, reason: unknown) => {
    if (abortCause !== null) return;
    abortCause = cause;
    controller.abort(reason);
  };

  const relayCallerAbort = () => abortOnce("caller", deps.signal?.reason);
  if (deps.signal) {
    if (deps.signal.aborted) relayCallerAbort();
    else deps.signal.addEventListener("abort", relayCallerAbort, { once: true });
  }

  let lastBytes = 0;
  let lastAt = clock();
  const startedAt = lastAt;
  const knownTotal =
    validPlan.source.fileSize !== null && validPlan.source.fileSize <= maxBytes
      ? validPlan.source.fileSize
      : null;

  // Every size the monitor observes for this run arrives here — and ONLY while
  // the run's monitor is still live: `runMonitoredAcquisition` owns that
  // liveness gate (CORRECTION-01 §7/§8). The byte policy and the progress
  // arithmetic below are the single-source downloader's own, unchanged.
  const onObserved = (observed: number) => {
    if (observed > maxBytes) {
      abortOnce("overflow", new AppError("TOO_LARGE"));
      return;
    }

    const now = clock();
    const elapsedMs = now - lastAt;
    const speed = elapsedMs > 0 ? ((observed - lastBytes) * 1000) / elapsedMs : null;
    lastBytes = observed;
    lastAt = now;

    if (!deps.onProgress) return;
    const progress =
      knownTotal !== null && knownTotal > 0
        ? Math.min(100, Math.max(0, (observed / knownTotal) * 100))
        : null;
    const eta =
      knownTotal !== null && speed !== null && speed > 0
        ? Math.max(0, (knownTotal - observed) / speed)
        : null;
    deps.onProgress({
      progress,
      downloadedBytes: observed,
      totalBytes: knownTotal,
      // Averaged over the whole run rather than one interval, so a single slow
      // poll does not report an implausible spike.
      speed:
        now > startedAt ? Math.max(0, (observed * 1000) / (now - startedAt)) : null,
      eta,
      stage: "Downloading",
    });
  };

  try {
    await runMonitoredAcquisition({
      runner,
      buildArgv: () =>
        buildYtdlpDownloadArgv({
          validatedUrl: safeUrl,
          workDir,
          plan: validPlan,
          maxFileSizeBytes: maxBytes,
        }),
      workDir,
      timeoutMs: networkTimeoutMs,
      signal: controller.signal,
      callerSignal: deps.signal,
      abortCause: () => abortCause,
      partPath,
      finalPath,
      statSize,
      pollMs,
      onObserved,
    });
  } finally {
    deps.signal?.removeEventListener("abort", relayCallerAbort);
  }

  return validateAcquiredSource({
    workDir,
    container,
    finalPath,
    maxBytes,
    readDir,
  });
}

/**
 * The ONE subprocess budget of an acquisition call, floored like analysis.
 *
 * Shared, so a split pair is bounded by exactly the configured limit a single
 * source is — the same `downloadTimeoutSeconds`, the same floor — and never by
 * a budget of its own.
 */
function acquisitionBudgetMs(limits: GenericDownloadLimits): number {
  return Math.max(
    YTDLP_DOWNLOAD_MIN_TIMEOUT_MS,
    Math.floor(limits.downloadTimeoutSeconds * 1000),
  );
}

// ── One monitored acquisition subprocess (shared) ────────────────────────────

/**
 * Runs ONE acquisition subprocess under the actual-byte monitor (§30), and
 * resolves only once it has exited zero — with its monitor already dead.
 *
 * Shared by the single-source downloader and by EACH half of a split pair, so
 * the load-bearing lifecycle rules below exist once rather than in two copies
 * that could drift. It owns no byte policy and no progress arithmetic:
 * `onObserved` receives the size observed for THIS run's `.part`/final path and
 * decides both.
 *
 * Nor does it own an abort cause. The first-cause latch belongs to the calling
 * OPERATION and is only read here, through `abortCause`, so the two runs of a
 * split pair are interpreted by one latch rather than two that could disagree.
 */
async function runMonitoredAcquisition(opts: {
  readonly runner: typeof runProcess;
  /**
   * Built lazily, inside the guarded region — where the single-source
   * downloader has always built it — so an argv failure is classified by the
   * same catch as every other failure of the run.
   */
  readonly buildArgv: () => readonly string[];
  readonly workDir: string;
  readonly timeoutMs: number;
  /** The operation-owned controller's signal: one abort path to the group. */
  readonly signal: AbortSignal;
  /** The caller's own signal, consulted only to recognise a real cancellation. */
  readonly callerSignal: AbortSignal | undefined;
  /** Reads the operation's one-way first-cause latch. */
  readonly abortCause: () => AbortCause;
  readonly partPath: string;
  readonly finalPath: string;
  readonly statSize: (path: string) => Promise<number | null>;
  readonly pollMs: number;
  /** Called synchronously, and ONLY while this run's monitor is live. */
  readonly onObserved: (observed: number) => void;
}): Promise<void> {
  const { statSize, partPath, finalPath } = opts;

  // ── monitor liveness gate (CORRECTION-01 §7/§8) ──────────────────────────
  //
  // `clearInterval` alone proves nothing: a sample already suspended on a
  // filesystem await resumes AFTER the timer is gone and would then emit
  // progress or abort, crossing the acquisition -> processing boundary. Worse,
  // by then the executor may have committed `beginProcessing()`, so a late
  // `downloading` progress write would be a state conflict that aborts a job
  // which had actually succeeded.
  //
  // So every side effect is gated on a liveness flag that `stopMonitor()` clears
  // SYNCHRONOUSLY. Because the event loop is single-threaded, any continuation
  // scheduled after that point observes `false` and becomes a pure no-op.
  //
  // SPLIT-03: the flag is per RUN. When a split pair's video run settles, its
  // monitor is dead before the video artifact is validated, before the audio
  // monitor exists and before the audio child is spawned — so a late video
  // sample can neither report progress during audio nor abort the audio child.
  let monitorActive = true;

  const sample = async () => {
    if (!monitorActive) return;

    // Either path may be absent: before yt-dlp creates the file, and after it
    // renames `.part` away. Neither is an error.
    const partSize = await statSize(partPath);
    if (!monitorActive) return;

    const finalSize = partSize === null ? await statSize(finalPath) : null;
    if (!monitorActive) return;

    const observed = partSize ?? finalSize;
    if (observed === null) return;

    opts.onObserved(observed);
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let sampling = false;
  const startMonitor = () => {
    timer = setInterval(() => {
      // Never overlap samples: a slow stat must not queue more work.
      if (sampling) return;
      sampling = true;
      void sample()
        .catch(() => {
          /* a stat failure must never throw into the event loop */
        })
        .finally(() => {
          sampling = false;
        });
    }, opts.pollMs);
    // The timer must never keep the process alive on its own (§31).
    timer.unref?.();
  };
  /**
   * Permanently disarms the monitor. Idempotent.
   *
   * Clearing the flag comes FIRST and synchronously, so an in-flight sample is
   * neutralised even though its filesystem await has not resolved yet. The
   * timer is then cleared so no further sample is scheduled.
   */
  const stopMonitor = () => {
    monitorActive = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  let result: RunResult;
  try {
    startMonitor();
    result = await opts.runner({
      command: YTDLP_RUNTIME.pythonPath,
      args: [...opts.buildArgv()],
      timeoutMs: opts.timeoutMs,
      env: buildYtdlpDownloadEnvironment({ workDir: opts.workDir }),
      signal: opts.signal,
      maxStdoutBytes: YTDLP_DOWNLOAD_MAX_STDOUT_BYTES,
      maxStderrBytes: YTDLP_DOWNLOAD_MAX_STDERR_BYTES,
    });
    // Disarm on the success path too, synchronously, so no in-flight sample can
    // emit progress or abort while the artifact is being validated, while the
    // next half of a split pair starts, or once the executor moves on to
    // `beginProcessing()`.
    stopMonitor();
  } catch (err: unknown) {
    // Disarm FIRST, before anything is interpreted. Otherwise a sample whose
    // stat resolves in this same turn could still latch a cause and convert an
    // already-determined TIMEOUT into a TOO_LARGE (§13).
    stopMonitor();

    // An internal size abort is a TOO_LARGE, not a cancellation. Checked before
    // the signal so it cannot be misreported as the user's own cancel (§30) —
    // and, because the cause latch is one-way, a caller abort that arrived
    // afterwards cannot overwrite it either.
    if (opts.abortCause() === "overflow") throw new AppError("TOO_LARGE");
    // Real cancellation propagates verbatim so the executor can tell it apart.
    if (opts.callerSignal?.aborted) throw err;
    if (err instanceof ProcessOutputLimitError) {
      // Over-limit output is never surfaced. The process group is already
      // terminated by the runner.
      throw new AppError("EXTRACTION_FAILED");
    }
    if (err instanceof AppError && err.code === "TIMEOUT") throw new AppError("TIMEOUT");
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  } finally {
    stopMonitor();
  }

  if (result.code !== 0) {
    // Both streams are read HERE and nowhere else: classified into a canonical
    // code and then dropped with the RunResult. Neither is logged, persisted,
    // attached to the thrown error, or returned.
    throw new AppError(classifyDownloadFailure(`${result.stderr}\n${result.stdout}`));
  }
}

// ── The split-pair downloader (SPLIT-03) ─────────────────────────────────────

/** One half's fixed, role-derived destination. */
type SplitHalfPaths = {
  readonly role: GenericSplitRole;
  readonly container: string;
  /** The exact directory entry a successful run of this half leaves behind. */
  readonly name: string;
  readonly finalPath: string;
  readonly partPath: string;
};

function splitHalfPaths(workDir: string, role: GenericSplitRole, container: string): SplitHalfPaths {
  return {
    role,
    container,
    name: `${YTDLP_SPLIT_OUTPUT_BASENAMES[role]}.${container}`,
    finalPath: expectedSplitSourcePath(workDir, role, container),
    partPath: expectedSplitPartPath(workDir, role, container),
  };
}

/**
 * The aggregate total for PROGRESS, or `null`.
 *
 * Known only when BOTH members reported a positive safe-integer size and their
 * safe sum fits the combined budget. It is a progress hint and nothing else:
 * no byte decision anywhere reads it, in either direction (§15).
 */
function splitKnownTotal(
  pair: GenericSplitExecutionPlan["pair"],
  maxBytes: number,
): number | null {
  const video = pair.video.fileSize;
  const audio = pair.audio.fileSize;
  if (video === null || audio === null) return null;
  if (!Number.isSafeInteger(video) || !Number.isSafeInteger(audio)) return null;
  if (video <= 0 || audio <= 0) return null;
  const sum = video + audio;
  return Number.isSafeInteger(sum) && sum <= maxBytes ? sum : null;
}

/**
 * Acquires BOTH sources of one approved split pair: the video-only member,
 * then the audio-only member, as two independent single-source yt-dlp runs.
 *
 * NOT REACHABLE YET. No analysis path builds a split preset source, so no
 * `merge-split` plan exists in Production, and the JobExecutor does not call
 * this function. It is the acquisition primitive executor integration will
 * wire in, reviewed first so its bounds are fixed before anything can reach it.
 *
 * Order of operations is a security property:
 *
 *   1. re-validate the plan — a pair, and nothing else;
 *   2. re-validate the submitted URL (§25) — ONE URL, used by both halves;
 *   3. refuse an already-cancelled caller;
 *   4. fix ONE deadline for the whole call;
 *   5. verify the EXACT pinned runtime, ONCE;
 *   6. VIDEO: exactly-empty workDir -> acquire -> validate;
 *   7. AUDIO: exactly-{video} workDir -> acquire within the REMAINING time and
 *      bytes -> validate;
 *   8. assert the combined size one final time.
 *
 * Steps 1-3 complete before ANY process is spawned, exactly as for a single
 * source. Everything after them shares:
 *
 *   - ONE deadline: probe + video + audio together get the configured budget
 *     once, never a fresh budget per subprocess;
 *   - ONE combined byte budget: `videoBytes + audioBytes <= maxFileSizeBytes`,
 *     enforced on ACTUAL bytes — extractor-reported sizes are progress hints,
 *     never authority;
 *   - ONE operation-owned AbortController linked to the caller, reaching
 *     whichever subprocess currently owns execution;
 *   - ONE first-cause latch, so a cancellation stays a cancellation and an
 *     overflow stays TOO_LARGE whichever half was running;
 *   - ONE monotonic aggregate progress stream.
 *
 * Strictly sequential, video first. The halves never overlap, which is what
 * keeps the byte budget, the deadline, cancellation and failure attribution
 * simple enough to audit.
 *
 * It performs NO local media work — no FFmpeg, no ffprobe, no merge — and
 * imports nothing that could. A failure of EITHER half fails the whole call:
 * there is no partial result, no substitute source and no retry. The workDir is
 * left to its lifecycle owner, the JobExecutor, to remove.
 */
export async function downloadGenericSplitSources(
  url: string,
  workDir: string,
  plan: GenericSplitExecutionPlan,
  deps: GenericDownloadDeps,
): Promise<GenericSplitSourcesDownload> {
  const runner = deps.runner ?? runProcess;
  const probe = deps.probeRuntime ?? probeYtdlpRuntime;
  const validate = deps.validateUrl ?? assertSafeUrl;
  const clock = deps.clock ?? Date.now;
  const statSize = deps.statSize ?? defaultStatSize;
  const readDir = deps.readDir ?? ((p: string) => fsReaddir(p));
  const pollMs = deps.sizePollMs ?? YTDLP_DOWNLOAD_SIZE_POLL_MS;

  // 1. The plan is re-parsed rather than trusted. The whole-plan schema is the
  //    authority for everything a pair must satisfy — `strategy: "yt-dlp"`,
  //    the SPLIT-01 pair invariants, the closed video-preset vocabulary, and a
  //    target equal to the closed pair table's — so none of that is restated
  //    here as a check that could never fire. What this adds is the refusal of
  //    every OTHER operation: the input type already excludes single-source
  //    plans, and this makes it true at runtime as well.
  const checkedPlan = GenericExecutionPlanSchema.safeParse(plan);
  if (!checkedPlan.success) throw new AppError("FORMAT_UNAVAILABLE");
  if (checkedPlan.data.operation !== "merge-split") throw new AppError("FORMAT_UNAVAILABLE");
  const validPlan = checkedPlan.data;

  if (!isAbsolute(workDir)) throw new AppError("PROCESSING_FAILED");
  const maxBytes = deps.limits.maxFileSizeBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AppError("PROCESSING_FAILED");
  }

  // Each half's fixed final and `.part` paths, from ROLE + approved container.
  // The role basenames differ, so these four paths cannot collide — and that is
  // proven here, before anything runs, rather than assumed (§18).
  const video = splitHalfPaths(workDir, "video", validPlan.pair.video.container);
  const audio = splitHalfPaths(workDir, "audio", validPlan.pair.audio.container);
  const paths = [video.finalPath, video.partPath, audio.finalPath, audio.partPath];
  if (new Set(paths).size !== paths.length) throw new AppError("PROCESSING_FAILED");

  // 2. The Worker's own URL/SSRF validation, ONCE, before anything is spawned.
  //    Both halves use this same validated URL: the API has no way to accept
  //    a second one.
  const { url: safeUrl } = await validate(url);

  // 3. An already-cancelled caller gets no subprocess at all.
  if (deps.signal?.aborted) {
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  }

  // 4. ONE deadline for the WHOLE call — probe, video and audio. Each
  //    subprocess receives only what is left of it.
  const deadline = clock() + acquisitionBudgetMs(deps.limits);

  // ONE operation-owned controller and ONE first-cause latch for the whole
  // call, linked to the caller before the probe starts, so user cancellation
  // and operator shutdown reach whichever subprocess currently owns execution
  // and both halves are interpreted by the same latch (CORRECTION-01 §11).
  const controller = new AbortController();
  let abortCause: AbortCause = null;
  const abortOnce = (cause: NonNullable<AbortCause>, reason: unknown) => {
    if (abortCause !== null) return;
    abortCause = cause;
    controller.abort(reason);
  };
  const relayCallerAbort = () => abortOnce("caller", deps.signal?.reason);
  if (deps.signal) {
    if (deps.signal.aborted) relayCallerAbort();
    else deps.signal.addEventListener("abort", relayCallerAbort, { once: true });
  }

  // Nothing is running between the halves, so a pending abort there is a
  // caller cancellation — or an overflow the video run latched in its final
  // instant. The latch decides which, exactly as it does mid-run.
  const throwIfAborted = () => {
    if (!controller.signal.aborted) return;
    if (abortCause === "overflow") throw new AppError("TOO_LARGE");
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  };

  try {
    // 5. The EXACT pinned runtime, probed ONCE for both halves, inside the
    //    shared deadline and under the operation's controller.
    const probeBudgetMs = Math.min(YTDLP_PROBE_TIMEOUT_MS, deadline - clock());
    if (probeBudgetMs <= 0) throw new AppError("TIMEOUT");
    const runtime = await probe({ signal: controller.signal, timeoutMs: probeBudgetMs });
    if (!runtime.available) throw new AppError("EXTRACTOR_UNAVAILABLE");

    // ── one monotonic aggregate progress stream (§31-§37) ──────────────────
    //
    // The durable job just says `downloading`, so the stream is ONE stream,
    // never "video 0->100, then audio 0->100". `downloadedBytes` counts actual
    // bytes: the observed video bytes, then the VALIDATED video bytes plus the
    // observed audio bytes.
    const knownTotal = splitKnownTotal(validPlan.pair, maxBytes);
    const startedAt = clock();
    let reportedBytes = 0;
    const report = (aggregate: number) => {
      // A monotonic floor: a restarted `.part` must never make the aggregate
      // visibly move backwards.
      reportedBytes = Math.max(reportedBytes, aggregate);
      if (!deps.onProgress) return;
      const downloaded = reportedBytes;
      const now = clock();
      // Averaged over the whole acquisition, and NOT reset at the audio
      // boundary.
      const speed =
        now > startedAt ? Math.max(0, (downloaded * 1000) / (now - startedAt)) : null;
      deps.onProgress({
        // Without a coherent total there is no honest percentage — and never
        // one made up from the configured maximum.
        progress:
          knownTotal !== null
            ? Math.min(100, Math.max(0, (downloaded / knownTotal) * 100))
            : null,
        downloadedBytes: downloaded,
        totalBytes: knownTotal,
        speed,
        eta:
          knownTotal !== null && speed !== null && speed > 0
            ? Math.max(0, (knownTotal - downloaded) / speed)
            : null,
        stage: "Downloading",
      });
    };

    /**
     * One half: exact prior directory state -> spawn within the REMAINING time
     * and bytes -> exact posterior directory state -> independent artifact
     * proof. No ffprobe: stream shape was approved by fresh analysis and bound
     * by the selector; probing local media is processing, not downloading.
     */
    const acquireHalf = async (
      half: SplitHalfPaths,
      acquiredBytes: number,
      entriesBefore: readonly string[],
    ): Promise<GenericSplitSourceArtifact> => {
      // Refuses ANY residue — including a pre-existing entry at this half's own
      // final or `.part` path (§41). Nothing is deleted and continued past.
      await assertExactEntries(workDir, entriesBefore, readDir);

      // Synchronous from here to the spawn, so nothing can interleave between
      // these checks and the child starting.
      throwIfAborted();
      const allowance = maxBytes - acquiredBytes;
      if (allowance <= 0) throw new AppError("TOO_LARGE");
      const timeoutMs = deadline - clock();
      if (timeoutMs <= 0) throw new AppError("TIMEOUT");

      await runMonitoredAcquisition({
        runner,
        buildArgv: () =>
          buildYtdlpSplitDownloadArgv({
            validatedUrl: safeUrl,
            workDir,
            plan: validPlan,
            role: half.role,
            maxFileSizeBytes: allowance,
          }),
        workDir,
        timeoutMs,
        signal: controller.signal,
        callerSignal: deps.signal,
        abortCause: () => abortCause,
        partPath: half.partPath,
        finalPath: half.finalPath,
        statSize,
        pollMs,
        onObserved: (observed) => {
          // The COMBINED live guard: bytes already validated for earlier halves
          // plus this half's observed bytes, measured from actual files.
          if (acquiredBytes + observed > maxBytes) {
            abortOnce("overflow", new AppError("TOO_LARGE"));
            return;
          }
          report(acquiredBytes + observed);
        },
      });

      await assertExactEntries(workDir, [...entriesBefore, half.name], readDir);
      return statAcquiredArtifact({
        workDir,
        container: half.container,
        finalPath: half.finalPath,
        maxBytes: allowance,
      });
    };

    // 6. VIDEO first, from an EMPTY job directory, with the whole byte budget.
    const videoArtifact = await acquireHalf(video, 0, []);

    // 7. AUDIO second — only after the video artifact is proven — with only what
    //    the video left of the deadline and of the byte budget.
    const audioArtifact = await acquireHalf(audio, videoArtifact.fileSize, [video.name]);

    // The audio run shared the job directory, so the video artifact returned
    // must still be the one that was validated.
    const videoNow = await statAcquiredArtifact({
      workDir,
      container: video.container,
      finalPath: video.finalPath,
      maxBytes,
    });
    if (videoNow.fileSize !== videoArtifact.fileSize) throw new AppError("PROCESSING_FAILED");

    // 8. The acquisition layer's final combined-size assertion. The merged
    //    output is bounded again, separately, by the merge primitive; neither
    //    check replaces the other, and no merge headroom is assumed here.
    const totalFileSize = videoArtifact.fileSize + audioArtifact.fileSize;
    if (!Number.isSafeInteger(totalFileSize) || totalFileSize > maxBytes) {
      throw new AppError("TOO_LARGE");
    }

    return { video: videoArtifact, audio: audioArtifact, totalFileSize };
  } finally {
    deps.signal?.removeEventListener("abort", relayCallerAbort);
  }
}

// ── Final artifact validation (§29) ──────────────────────────────────────────

/**
 * Independently validates the local original after a successful exit.
 *
 * A zero exit status is yt-dlp's opinion; this is the Worker's. Every property
 * the rest of the pipeline relies on is proven here rather than assumed, and an
 * unexpected local shape is refused rather than guessed at — picking "the
 * probable file" out of an unexpected directory is exactly how a fragment or a
 * leftover artifact becomes the delivered media.
 */
async function validateAcquiredSource(opts: {
  workDir: string;
  container: string;
  finalPath: string;
  maxBytes: number;
  readDir: (path: string) => Promise<string[]>;
}): Promise<GenericOriginalDownload> {
  const { workDir, container, finalPath, maxBytes, readDir } = opts;

  const expectedName = `${YTDLP_DOWNLOAD_OUTPUT_BASENAME}.${container}`;

  // A successful run leaves EXACTLY the one expected file. This single check
  // subsumes: a surviving `.part`, retained fragments (`.part-FragN`), a second
  // media file from a merge that should not have happened, and any side file a
  // future option might write.
  await assertExactEntries(workDir, [expectedName], readDir);

  return statAcquiredArtifact({ workDir, container, finalPath, maxBytes });
}

/**
 * Proves the job directory holds EXACTLY `expected` — no more, no fewer —
 * whatever order the directory happens to enumerate in.
 *
 * Shared by both primitives. The single-source downloader expects one name; a
 * split pair expects, in turn, nothing, then the video artifact, then both.
 * An unexpected entry is refused rather than guessed about: picking "the
 * probable file" out of an unexpected directory is exactly how a fragment or
 * a leftover artifact becomes the delivered media.
 */
async function assertExactEntries(
  workDir: string,
  expected: readonly string[],
  readDir: (path: string) => Promise<string[]>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readDir(workDir);
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }
  if (!sameEntries(entries, expected)) throw new AppError("PROCESSING_FAILED");
}

/** Order-independent exact equality, duplicates included. */
function sameEntries(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((name, i) => name === e[i]);
}

/**
 * Containment, symlink, regular-file and size proof for ONE acquired artifact.
 *
 * `maxBytes` is that artifact's allowance: the whole limit for a single source
 * or a split pair's video half, and only the remainder for its audio half.
 */
async function statAcquiredArtifact(opts: {
  workDir: string;
  container: string;
  finalPath: string;
  maxBytes: number;
}): Promise<GenericOriginalDownload> {
  const { workDir, container, finalPath, maxBytes } = opts;

  // Containment, symlink and regular-file checks against the CANONICAL path.
  const resolvedWorkDir = resolve(workDir);
  const resolvedFile = resolve(finalPath);
  if (!resolvedFile.startsWith(resolvedWorkDir + "/")) {
    throw new AppError("PROCESSING_FAILED");
  }

  let size: number;
  try {
    const link = await fsLstat(resolvedFile);
    if (link.isSymbolicLink()) throw new AppError("PROCESSING_FAILED");

    const canonical = await fsRealpath(resolvedFile);
    // The canonical parent must be the canonical workDir, so a symlinked
    // ancestor cannot place the file outside the job's own directory.
    if (dirname(canonical) !== (await fsRealpath(resolvedWorkDir))) {
      throw new AppError("PROCESSING_FAILED");
    }

    const s = await fsStat(canonical);
    if (!s.isFile()) throw new AppError("PROCESSING_FAILED");
    if (!Number.isSafeInteger(s.size)) throw new AppError("PROCESSING_FAILED");
    if (s.size <= 0) throw new AppError("PROCESSING_FAILED");
    // The final stat is the LAST of the three size gates (metadata bound,
    // --max-filesize, live watcher). It catches a file that grew past the limit
    // between the final poll and process exit.
    if (s.size > maxBytes) throw new AppError("TOO_LARGE");
    size = s.size;
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    throw new AppError("PROCESSING_FAILED");
  }

  return { filePath: resolve(finalPath), container, fileSize: size };
}
