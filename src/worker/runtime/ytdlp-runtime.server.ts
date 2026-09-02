import { runProcess, type RunResult } from "../../services/processing/process-runner.server.ts";

/**
 * Worker-owned yt-dlp RUNTIME foundation (Phase 10C1).
 *
 * This module owns exactly one thing: the identity of the pinned yt-dlp
 * runtime shipped in the Worker image, and the closed argument/environment
 * policy every future invocation of it must use.
 *
 * It deliberately owns NONE of the following, and must never gain them here:
 *   - analysis or download of a user-supplied URL;
 *   - URL handling, validation or interpretation of any kind;
 *   - format selection or `-f` construction;
 *   - output templates or filesystem destinations;
 *   - a generic extractor registry or media dispatch.
 *
 * The only yt-dlp subprocess operation this module performs — and, after
 * Phase 10C1, the only one that exists anywhere in Production Worker code —
 * is a NON-NETWORK version probe. Generic user-URL execution is a later,
 * separately authorized phase.
 *
 * This module replaces the Worker's former dependence on the legacy
 * `src/services/extractors/ytdlp.server.ts`, which the diagnostics probe used
 * to reach only to run `--version`. That legacy module is a Vercel-era
 * extractor whose `download()` path performs FFmpeg work; the Worker must not
 * load it at all.
 */

/**
 * The exact pinned runtime this image ships.
 *
 * Every value here is verified against the upstream release and is asserted
 * against `Dockerfile.worker` by `container-policy.test.ts`, so the code and
 * the image cannot drift apart. Changing the runtime means changing this
 * object AND the Dockerfile in the same reviewed commit.
 *
 * `sha256` is the digest published in the release's own `SHA2-256SUMS`.
 * Upgrades are code-review and deployment events, never runtime events.
 */
export const YTDLP_RUNTIME = Object.freeze({
  /**
   * Debian Bookworm's system interpreter. yt-dlp 2026.08.19 raises ImportError
   * on Python < 3.10 (`yt_dlp/__init__.py`); Bookworm ships 3.11, so the
   * requirement is satisfied by the base image with no venv and no pip.
   */
  pythonPath: "/usr/bin/python3",

  /** Minimum interpreter the pinned yt-dlp release accepts. */
  minPythonVersion: "3.10",

  /**
   * The official platform-independent Unix zipimport executable, installed
   * root-owned and mode 0555 on the read-only root filesystem. It is NOT the
   * PyInstaller build: that one unpacks itself into a temporary directory at
   * every run, which is incompatible with this container's read-only root and
   * its `noexec` media tmpfs.
   */
  artifactPath: "/usr/local/lib/videofetch/yt-dlp",

  /** Exact upstream release. The probe accepts this string and nothing else. */
  expectedVersion: "2026.08.19",

  /** The exact asset the image fetches. Immutable release URL, never `latest`. */
  releaseUrl:
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp",

  /** Published in the release's SHA2-256SUMS; enforced at build time. */
  sha256: "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6",

  /**
   * The `yt_dlp_ejs` package version bundled INSIDE the zipimport artifact
   * (`yt_dlp_ejs/_version.py`), matching the version its vendored solver
   * expects (`.../jsc/_builtin/vendor/_info.py`). Because the requisite
   * package ships in the artifact, `--no-remote-components` costs nothing:
   * yt-dlp never needs to fetch EJS from npm or GitHub at runtime.
   */
  bundledEjsVersion: "0.8.0",
} as const);

/** Bounded wall-clock budget for the version probe. */
export const YTDLP_PROBE_TIMEOUT_MS = 15_000;

/**
 * Environment variables that must never reach the yt-dlp child.
 *
 * This list is DOCUMENTATION and a test target, not the mechanism: the
 * environment builder constructs a fresh object and never spreads
 * `process.env`, so exclusion is structural rather than subtractive. A new
 * dangerous variable appearing in the Worker's ambient environment therefore
 * cannot leak just because nobody remembered to add it here.
 */
export const YTDLP_FORBIDDEN_ENVIRONMENT = Object.freeze([
  // Proxy configuration would redirect every media request through a host the
  // safe-egress policy never vetted.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // Interpreter hijacking: an injected module search path is arbitrary code.
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONUSERBASE",
  "PYTHONSTARTUP",
  // Ambient configuration discovery roots.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // NOTE: the Worker's own secrets and object-store settings are deliberately
  // NOT enumerated here. Naming them would scatter secret identifiers outside
  // the server-only composition layers that own them — a boundary
  // `control-plane-boundary.test.ts` enforces across the whole repository —
  // and it would buy nothing: `buildYtdlpEnvironment` is an allowlist, so
  // every variable absent from it is excluded whether or not anyone wrote it
  // down. The test below proves that structurally, using sentinel values.
] as const);

/**
 * Builds the COMPLETE environment for a yt-dlp subprocess.
 *
 * Allowlist by construction: the returned object is created from nothing, so
 * no ambient variable can survive. `HOME`, `TMPDIR` and the XDG roots are
 * pointed at the caller's own working directory (or an unwritable sentinel)
 * so that even if a future yt-dlp version consults them, it finds nothing the
 * operator or an attacker placed there.
 */
export function buildYtdlpEnvironment(opts: { workDir?: string } = {}): NodeJS.ProcessEnv {
  // A path that cannot exist as a real configuration root. Config discovery is
  // already disabled by argument policy; this is the second layer.
  const base = opts.workDir ?? "/nonexistent";
  return Object.freeze({
    // Minimal search path. Every executable this policy uses is addressed by
    // absolute path, so PATH exists only to keep well-behaved library code
    // from failing in surprising ways.
    PATH: "/usr/bin:/bin",
    // Never the Worker's real home: a `~/.config/yt-dlp/config` or a `~/.netrc`
    // discovered here would be ambient configuration.
    HOME: base,
    TMPDIR: base,
    XDG_CONFIG_HOME: `${base}/.config`,
    XDG_CACHE_HOME: `${base}/.cache`,
    // Defence in depth for the interpreter itself.
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    // Deterministic, locale-independent output so the version comparison and
    // any future parsing cannot shift under a different host locale.
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
  }) as NodeJS.ProcessEnv;
}

/**
 * The approved JavaScript runtime.
 *
 * yt-dlp 2026.08.19 enables ONLY `deno` by default (`--js-runtimes` defaults to
 * `['deno']`), and resolves an unlocated runtime by searching PATH. Neither is
 * acceptable here: Deno is not in this image, and ambient discovery is exactly
 * what the closed policy exists to prevent.
 *
 * The path is derived from the running Worker process rather than from
 * configuration, so it is by definition the Node binary this image already
 * trusts and executes, and there is no operator-supplied executable path to
 * validate or get wrong.
 */
export function approvedJsRuntimePath(): string {
  return process.execPath;
}

/**
 * The closed base argument policy applied to EVERY yt-dlp invocation.
 *
 * Callers may not extend this with arbitrary options: the only parameter is
 * the working directory, and the returned array is frozen. Nothing here
 * accepts, interpolates or forwards user input, and there is deliberately no
 * URL, no `-f` and no `-o` — Phase 10C1 has no user-URL execution path at all.
 *
 * Every flag below is verified against yt-dlp 2026.08.19's own `options.py`
 * rather than assumed from historical spelling. In particular the plugin
 * switch is `--no-plugin-dirs` (there is no `--no-plugins` in this release),
 * and `--no-js-runtimes` MUST precede `--js-runtimes` because the latter
 * appends to whatever the former did not clear.
 */
export function ytdlpPolicyArgs(opts: { workDir?: string } = {}): readonly string[] {
  void opts;
  return Object.freeze([
    // ── configuration isolation ──────────────────────────────────────────
    // No system, user, home, XDG or portable (cwd) yt-dlp config is loaded.
    "--ignore-config",
    "--no-config-locations",

    // ── plugin isolation ─────────────────────────────────────────────────
    // Clears the default plugin search directories. A yt-dlp plugin is
    // arbitrary Python running inside the media namespace; Phase-10 v1 allows
    // none.
    "--no-plugin-dirs",

    // ── JavaScript runtime policy ────────────────────────────────────────
    // Clear the built-in default (`deno`) and every previously enabled
    // runtime, then enable exactly Node at the exact binary this Worker is
    // already running. Deno, Bun and QuickJS remain disabled and unlocatable.
    "--no-js-runtimes",
    `--js-runtimes=node:${approvedJsRuntimePath()}`,

    // ── remote component policy ──────────────────────────────────────────
    // Never fetch EJS (or anything else) from npm or GitHub at runtime. The
    // requisite yt_dlp_ejs package is bundled in the pinned artifact, so this
    // is a hard assertion of the default rather than a functional loss.
    "--no-remote-components",

    // ── update policy ────────────────────────────────────────────────────
    // Belt to the read-only, root-owned artifact's braces. The Worker can
    // never rewrite its own runtime; this makes the intent explicit too.
    "--no-update",

    // ── credential policy ────────────────────────────────────────────────
    // Phase-10 v1 is public-sources-only. `--netrc` is deliberately NOT
    // passed (it defaults to off and this release has no `--no-netrc`), and
    // no username, password, token or authorization header is ever supplied.
    "--no-cookies",
    "--no-cookies-from-browser",

    // ── downloader policy ────────────────────────────────────────────────
    // Acquisition uses yt-dlp's NATIVE downloader. See YTDLP_FFMPEG_ACQUISITION_MODES
    // below for what this does and does not guarantee — it is emphatically not
    // "yt-dlp will never invoke FFmpeg".
    //
    // `--downloader` parses as `[PROTO:]NAME` into a dict, so a bare value
    // becomes `{default: "native"}`. It is a fixed application-owned constant:
    // no caller, and no user, can choose a downloader or pass downloader args.
    "--downloader=native",
  ] as const);
}

/**
 * Source modes where yt-dlp 2026.08.19 selects `FFmpegFD` for ACQUISITION even
 * under `--downloader=native`, and which later generic integration must
 * therefore reject (or separately design for) rather than execute.
 *
 * This matters because of an accepted Worker invariant:
 *
 *     downloading  = network acquisition
 *     processing   = local FFmpeg/remux/transcode/extraction
 *
 * A yt-dlp download that internally shells out to FFmpeg performs local media
 * work while the durable job still says `downloading`, which breaks that
 * boundary. Phase 10C1 has no user-URL execution path at all, so nothing here
 * is enforced yet; this list is the recorded integration gate.
 *
 * Determined by reading `yt_dlp/downloader/__init__.py` in the pinned release
 * and confirmed by exercising `_get_suitable_downloader` against it:
 *
 *     https               is_live=False  -> HttpFD          (native)
 *     m3u8_native         is_live=False  -> HlsFD           (native)
 *     m3u8_native         is_live=True   -> FFmpegFD        <-- forced
 *     http_dash_segments  is_live=True   -> DashSegmentsFD  (native prevents FFmpegFD)
 *     rtmp_ffmpeg                        -> FFmpegFD        <-- forced
 */
export const YTDLP_FFMPEG_ACQUISITION_MODES = Object.freeze([
  // `if protocol in ('m3u8', 'm3u8_native'): if info_dict.get('is_live'): return FFmpegFD`
  // — this test runs BEFORE the `native` branch, so the downloader policy
  // cannot override it.
  "live HLS (m3u8 / m3u8_native with is_live)",
  // PROTOCOL_MAP maps this protocol directly to FFmpegFD; `native` is only
  // consulted for m3u8/m3u8_native and http_dash_segments.
  "rtmp_ffmpeg",
  // `if (section_start or section_end) and FFmpegFD.can_download(...)` is the
  // FIRST check in `_get_suitable_downloader`, ahead of any downloader
  // preference. We never pass `--download-sections`, so this is unreachable
  // today; it is listed so a future option addition cannot reintroduce it
  // silently.
  "section downloads (--download-sections)",
  // `if external_downloader is None and to_stdout and FFmpegFD.can_merge_formats(...)`.
  // Passing `--downloader=native` makes `external_downloader` non-None, which
  // already disables this branch; it stays listed because `-o -` plus a
  // multi-format selection is the shape that would reopen it.
  "stdout output with a merge-requiring format selection",
  // The top-level `get_suitable_downloader` returns FFmpegFD when every
  // protocol in a `+`-joined selection resolves to it and the formats can be
  // merged. A single-format selection cannot reach this.
  "multi-protocol format selections that resolve wholly to FFmpegFD",
] as const);

/** The outcome of a runtime probe. Never carries raw subprocess output. */
export type YtdlpRuntimeStatus = {
  /** True only when the exact pinned version answered. */
  readonly available: boolean;
  /** The reported version when it matched the pin, else null. */
  readonly version: string | null;
  /** Stable, non-secret reason code. Safe for logs; never surfaced raw. */
  readonly reason:
    | "ok"
    | "version_mismatch"
    | "malformed_output"
    | "process_error"
    | "timeout";
};

const UNAVAILABLE = (reason: YtdlpRuntimeStatus["reason"]): YtdlpRuntimeStatus =>
  Object.freeze({ available: false, version: null, reason });

type ProcessRunner = typeof runProcess;
let processRunner: ProcessRunner = runProcess;

/** Test seam. Production always uses the hardened process runner. */
export function setYtdlpRuntimeProcessRunnerForTests(runner: ProcessRunner | null): void {
  processRunner = runner ?? runProcess;
}

/**
 * Extracts the version from `--version` output.
 *
 * yt-dlp prints the bare version and nothing else, so this is deliberately
 * strict: exactly one non-empty line matching the release-tag shape. The
 * legacy probe accepted any output containing `/20\d{2}/`, which would have
 * accepted an arbitrary different yt-dlp build — far too loose for a runtime
 * whose exact version is a reviewed, pinned deployment decision.
 */
export function parseYtdlpVersion(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  return /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(lines[0]) ? lines[0] : null;
}

/**
 * Probes the pinned yt-dlp runtime.
 *
 * Executes the interpreter and the artifact by ABSOLUTE path, under the closed
 * environment and the full base argument policy, and asks only for the
 * version. It performs no network request, touches no user input, and returns
 * `available: true` only when the reported version equals the pin exactly.
 *
 * Every failure mode — missing interpreter, missing artifact, wrong version,
 * malformed output, spawn error, timeout — is reported as unavailable with a
 * bounded reason code. Raw stdout/stderr never escapes this function.
 */
export async function probeYtdlpRuntime(): Promise<YtdlpRuntimeStatus> {
  let result: RunResult;
  try {
    result = await processRunner({
      command: YTDLP_RUNTIME.pythonPath,
      args: [YTDLP_RUNTIME.artifactPath, ...ytdlpPolicyArgs(), "--version"],
      timeoutMs: YTDLP_PROBE_TIMEOUT_MS,
      env: buildYtdlpEnvironment(),
    });
  } catch (err: unknown) {
    // The runner rejects with a TIMEOUT AppError when it killed the process
    // group, and with the spawn error otherwise.
    const code = (err as { code?: unknown } | null)?.code;
    return UNAVAILABLE(code === "TIMEOUT" ? "timeout" : "process_error");
  }

  if (result.code !== 0) return UNAVAILABLE("process_error");

  const version = parseYtdlpVersion(result.stdout);
  if (version === null) return UNAVAILABLE("malformed_output");
  if (version !== YTDLP_RUNTIME.expectedVersion) return UNAVAILABLE("version_mismatch");

  return Object.freeze({ available: true, version, reason: "ok" as const });
}
