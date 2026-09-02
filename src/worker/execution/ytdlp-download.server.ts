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
import { buildGenericFormatSelector } from "./generic-source.ts";
import { GenericExecutionPlanSchema, type GenericExecutionPlan } from "./format-plan.ts";

/**
 * Worker-owned GENERIC ORIGINAL ACQUISITION (Phase 10C3 §20).
 *
 * Takes one already-validated generic execution plan and produces exactly ONE
 * local original source artifact. It is the network half of generic execution
 * and nothing else.
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
 *   2. a single progressive http/https source, so no fragment or manifest
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
 * no format re-selection, and never more than one returned file. Audio
 * extraction and MP3 transcoding are the JobExecutor's, performed with the
 * Worker's own FFmpeg strictly after `beginProcessing()` commits.
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
  readonly plan: GenericExecutionPlan;
  readonly maxFileSizeBytes: number;
}): readonly string[] {
  return Object.freeze([
    YTDLP_RUNTIME.artifactPath,
    ...ytdlpPolicyArgs(),
    ...ytdlpDownloadPolicyArgs({
      formatSelector: buildGenericFormatSelector(opts.plan.source),
      outputTemplate: outputTemplateFor(opts.workDir),
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

export type GenericDownloadLimits = {
  readonly maxFileSizeBytes: number;
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
  const budgetMs = Math.max(
    YTDLP_DOWNLOAD_MIN_TIMEOUT_MS,
    Math.floor(deps.limits.downloadTimeoutSeconds * 1000),
  );
  const deadline = clock() + budgetMs;

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
  let overflowed = false;
  const abortForOverflow = () => {
    overflowed = true;
    controller.abort(new AppError("TOO_LARGE"));
  };
  const relayCallerAbort = () => controller.abort(deps.signal?.reason);
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

  const sample = async () => {
    // Either path may be absent: before yt-dlp creates the file, and after it
    // renames `.part` away. Neither is an error.
    const partSize = await statSize(partPath);
    const finalSize = partSize === null ? await statSize(finalPath) : null;
    const observed = partSize ?? finalSize;
    if (observed === null) return;

    if (observed > maxBytes) {
      abortForOverflow();
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
    }, pollMs);
    // The timer must never keep the process alive on its own (§31).
    timer.unref?.();
  };
  const stopMonitor = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  let result: RunResult;
  try {
    startMonitor();
    result = await runner({
      command: YTDLP_RUNTIME.pythonPath,
      args: [
        ...buildYtdlpDownloadArgv({
          validatedUrl: safeUrl,
          workDir,
          plan: validPlan,
          maxFileSizeBytes: maxBytes,
        }),
      ],
      timeoutMs: networkTimeoutMs,
      env: buildYtdlpDownloadEnvironment({ workDir }),
      signal: controller.signal,
      maxStdoutBytes: YTDLP_DOWNLOAD_MAX_STDOUT_BYTES,
      maxStderrBytes: YTDLP_DOWNLOAD_MAX_STDERR_BYTES,
    });
  } catch (err: unknown) {
    // An internal size abort is a TOO_LARGE, not a cancellation. It is checked
    // FIRST so it cannot be misreported as the user's own cancel (§30).
    if (overflowed) throw new AppError("TOO_LARGE");
    // Real cancellation propagates verbatim so the executor can tell it apart.
    if (deps.signal?.aborted) throw err;
    if (err instanceof ProcessOutputLimitError) {
      // Over-limit output is never surfaced. The process group is already
      // terminated by the runner.
      throw new AppError("EXTRACTION_FAILED");
    }
    if (err instanceof AppError && err.code === "TIMEOUT") throw new AppError("TIMEOUT");
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  } finally {
    stopMonitor();
    deps.signal?.removeEventListener("abort", relayCallerAbort);
  }

  if (result.code !== 0) {
    // Both streams are read HERE and nowhere else: classified into a canonical
    // code and then dropped with the RunResult. Neither is logged, persisted,
    // attached to the thrown error, or returned.
    throw new AppError(classifyDownloadFailure(`${result.stderr}\n${result.stdout}`));
  }

  return validateAcquiredSource({
    workDir,
    container,
    finalPath,
    maxBytes,
    readDir,
  });
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

  let entries: string[];
  try {
    entries = await readDir(workDir);
  } catch {
    throw new AppError("PROCESSING_FAILED");
  }

  const expectedName = `${YTDLP_DOWNLOAD_OUTPUT_BASENAME}.${container}`;

  // A successful run leaves EXACTLY the one expected file. This single check
  // subsumes: a surviving `.part`, retained fragments (`.part-FragN`), a second
  // media file from a merge that should not have happened, and any side file a
  // future option might write.
  if (entries.length !== 1 || entries[0] !== expectedName) {
    throw new AppError("PROCESSING_FAILED");
  }

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
