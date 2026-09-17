import { z } from "zod";
import { AppError } from "../../lib/errors.ts";
import { assertSafeUrl } from "../../lib/security/ssrf.server.ts";
import {
  ProcessOutputLimitError,
  runProcess,
  type RunResult,
} from "../../services/processing/process-runner.server.ts";
import {
  VideoMetadataSchema,
  WorkerAnalyzeRequestSchema,
  type WorkerQualityPreset,
  type WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import {
  GENERIC_VIDEO_SOURCE_CONTAINERS,
  GenericSourceSelectionSchema,
  GenericSplitSourceSelectionSchema,
  isSafeFormatId,
  splitTargetContainer,
  toGenericSourceContainer,
  type GenericAudioConstraint,
  type GenericPresetSource,
  type GenericSourceContainer,
  type GenericSourceProtocol,
  type GenericSourceSelection,
  type GenericSourceSelections,
  type GenericSplitTargetContainer,
  type GenericVideoConstraint,
} from "../execution/generic-source.ts";
import {
  YTDLP_PROBE_TIMEOUT_MS,
  YTDLP_RUNTIME,
  buildYtdlpEnvironment,
  probeYtdlpRuntime,
  ytdlpPolicyArgs,
  type YtdlpProbeOptions,
  type YtdlpRuntimeStatus,
} from "../runtime/ytdlp-runtime.server.ts";

/**
 * Worker-owned GENERIC yt-dlp analysis (Phase 10C2).
 *
 * This module turns one submitted URL into at most one bounded, sanitized
 * `WorkerVideoMetadata` describing a single media item, using a fixed,
 * application-owned yt-dlp command line. It is the analysis half of generic
 * support and nothing more.
 *
 * ─── What this module is NOT, and must never become here ────────────────────
 *
 *   - It is not reachable from Production. Nothing in `WorkerService`,
 *     `runtime.server.ts`, `JobExecutor` or the Vercel control plane calls it,
 *     and `control-plane-boundary.test.ts` asserts that structurally.
 *   - It does not download media. `--skip-download` plus `-J`'s implied
 *     simulation means the process acquires metadata and exits.
 *   - It does not select a yt-dlp format. There is no `-f` anywhere on this
 *     path, and no upstream `format_id` is even parsed (see RawFormatSchema).
 *   - It does not reuse the legacy Vercel-era extractor
 *     (`src/services/extractors/ytdlp.server.ts`), its format selector, or its
 *     message mapper. Those carry a download path that runs FFmpeg and a
 *     regex taxonomy that leaks upstream text.
 *
 * ─── Trust posture ──────────────────────────────────────────────────────────
 *
 * Everything yt-dlp prints is UNTRUSTED. The only values that survive into the
 * returned metadata are:
 *
 *   - fields this module validated against a closed Zod schema, then bounded
 *     and sanitized itself;
 *   - values this module owns outright (`extractor`, preset ids, `formats: []`);
 *   - the URL the Worker itself validated, which remains authoritative over
 *     anything upstream reports as `webpage_url` / `original_url`.
 *
 * Raw stdout and stderr exist transiently in memory for classification only.
 * Neither is logged, persisted, attached to an error, or returned.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on the analysis subprocess's stdout.
 *
 * This is the FIRST bound in the chain and the only one that constrains what
 * reaches memory at all: the raw format-count bound below can only be applied
 * after `JSON.parse`, which has already materialized the whole document. A
 * legitimate `-J` info document is a few hundred KB even for a site with
 * hundreds of formats, so 4 MiB is generous while still bounding a hostile or
 * malfunctioning extractor by three orders of magnitude.
 *
 * On overflow the process group is terminated and NOTHING is parsed: a
 * truncated JSON document must never be interpreted as extractor output.
 */
export const YTDLP_ANALYSIS_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/**
 * Hard ceiling on the analysis subprocess's stderr.
 *
 * stderr is only ever read to CLASSIFY a failure into a canonical code, so it
 * needs far less headroom than stdout. Overflow is itself a failure.
 */
export const YTDLP_ANALYSIS_MAX_STDERR_BYTES = 256 * 1024;

/**
 * Maximum raw formats accepted from one info document.
 *
 * Sites with genuinely many renditions (adaptive ladders across several codecs
 * and languages) land in the low hundreds; 512 accepts those and fails closed
 * beyond. Failing closed rather than truncating is deliberate: silently
 * dropping the tail would make preset selection depend on where the cut fell.
 */
export const YTDLP_ANALYSIS_MAX_RAW_FORMATS = 512;

/**
 * Maximum presets this module will ever emit.
 *
 * The preset vocabulary is closed and application-owned (see
 * GENERIC_PRESET_ID_PATTERN), so this can never be exceeded by upstream data;
 * it is asserted as a structural invariant rather than trusted.
 */
export const YTDLP_ANALYSIS_MAX_PRESETS = 11;

/** Upper bound on any upstream string that becomes returned metadata. */
export const YTDLP_ANALYSIS_MAX_TITLE_LENGTH = 1024;

/** Bounded wall-clock budget is supplied by the caller; this is the floor. */
export const YTDLP_ANALYSIS_MIN_TIMEOUT_MS = 1_000;

// ── Acquisition eligibility ──────────────────────────────────────────────────

/**
 * The ONLY source protocols a Phase-10 v1 candidate may use.
 *
 * Determined by reading `_get_suitable_downloader` in the pinned 2026.08.19
 * release: with `--downloader=native` in the base policy, a plain `http`/`https`
 * format resolves to `HttpFD`, which acquires bytes and nothing else.
 *
 * Native HLS is deliberately EXCLUDED even though `m3u8_native` selects `HlsFD`
 * under the native downloader policy. `HlsFD.real_download` inspects the media
 * playlist at DOWNLOAD time and, when `can_download()` rejects it (DRM markers,
 * AES-128 with ffmpeg present, other unsupported tags), constructs an
 * `FFmpegFD` and delegates to it — `yt_dlp/downloader/hls.py`, the
 * `if not can_download:` branch. That decision depends on manifest bytes this
 * analysis never fetches, so HLS eligibility CANNOT be proven native at
 * analysis time, and advertising it would risk local FFmpeg work running while
 * a future durable job still reports `downloading`.
 *
 * This is the fail-closed reading of the recorded acquisition boundary. It can
 * be widened later by a phase that proves the manifest is native — with
 * evidence, not optimism.
 */
export const YTDLP_V1_NATIVE_PROTOCOLS = Object.freeze(["http", "https"] as const);

/**
 * `live_status` values that make a source ineligible for Phase-10 v1.
 *
 * Per the pinned release's field documentation (`extractor/common.py`), the
 * vocabulary is `is_live`, `is_upcoming`, `was_live`, `not_live`, `post_live`,
 * or absent (unknown). `post_live` means "was live, but the VOD is not yet
 * processed", which is a wait-for-media state, so it is rejected alongside the
 * two obvious ones. `was_live` describes a finished, fixed-length recording
 * and is fine.
 */
export const YTDLP_REJECTED_LIVE_STATUSES = Object.freeze([
  "is_live",
  "is_upcoming",
  "post_live",
] as const);

// Phase 10C2 kept a DENYLIST of non-media extensions here (mhtml, jpg, vtt, …).
// Phase 10C3 replaces it with the closed source-container ALLOWLIST in
// `generic-source.ts`: a denylist has to anticipate every junk extension an
// extractor might invent, while an allowlist rejects them all by default and
// additionally refuses the merely-unsupported ones (mkv, mov, avi) that the
// download path could not honour anyway.

// ── Application-owned preset vocabulary ──────────────────────────────────────

/**
 * The closed set of preset identifiers generic v1 may emit.
 *
 * Every generic preset's `id` and `formatId` must match this pattern, which is
 * how the Phase-10B requirement "no raw yt-dlp format id may become a
 * browser-selectable value" is enforced rather than merely intended. The
 * browser's advanced selector echoes `formatId` back on job creation, so an
 * upstream string appearing here would become a user-controlled selector in a
 * later phase.
 */
export const GENERIC_PRESET_ID_PATTERN = /^preset:(best|2160|1440|1080|720|480|360|240|144|audio|mp3)$/;

/** Resolution buckets, highest first. Mirrors the product's existing ladder. */
const RESOLUTION_STEPS = Object.freeze([
  { minHeight: 2160, id: "preset:2160", label: "2160p / 4K", resolution: "2160p" },
  { minHeight: 1440, id: "preset:1440", label: "1440p", resolution: "1440p" },
  { minHeight: 1080, id: "preset:1080", label: "1080p", resolution: "1080p" },
  { minHeight: 720, id: "preset:720", label: "720p", resolution: "720p" },
  { minHeight: 480, id: "preset:480", label: "480p", resolution: "480p" },
  { minHeight: 360, id: "preset:360", label: "360p", resolution: "360p" },
  { minHeight: 240, id: "preset:240", label: "240p", resolution: "240p" },
  { minHeight: 144, id: "preset:144", label: "144p", resolution: "144p" },
] as const);

// ── Descendant isolation ─────────────────────────────────────────────────────

/**
 * PATH for the analysis child. It resolves nothing.
 *
 * The Phase-10C1 base environment sets `PATH=/usr/bin:/bin` so that
 * well-behaved library code does not fail in surprising ways. For generic
 * ANALYSIS that is too permissive: the Worker image intentionally ships
 * `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`, and yt-dlp resolves both by BARE
 * NAME when no ffmpeg location is configured (see
 * `YTDLP_ANALYSIS_FFMPEG_LOCATION`). Leaving `/usr/bin` on the child's PATH
 * would therefore hand a metadata-only subprocess a working media toolchain.
 *
 * This directory does not exist in the image, so every PATH lookup fails. It is
 * deliberately a nonexistent absolute path rather than an empty string: an
 * empty PATH is interpreted by some resolvers as "use the system default"
 * (`confstr(_CS_PATH)`, which is `/bin:/usr/bin`), which would silently restore
 * exactly what this removes.
 *
 * Nothing the analysis actually needs is discovered through PATH — the Python
 * interpreter, the yt-dlp artifact and the approved Node runtime are all passed
 * as absolute paths.
 */
export const YTDLP_ANALYSIS_PATH = "/nonexistent/videofetch-yt-dlp-analysis-no-path";

/**
 * A fixed, nonexistent location handed to `--ffmpeg-location`.
 *
 * This is the second, independent half of the FFmpeg boundary, and it is the
 * half that works even if the PATH restriction were ever weakened.
 *
 * Verified against yt-dlp 2026.08.19's `FFmpegPostProcessor._determine_executables`:
 *
 *     location = self.get_param('ffmpeg_location', ...)
 *     if location is None:
 *         return {p: p for p in programs}        # bare 'ffmpeg'/'ffprobe' -> PATH
 *     if not os.path.exists(location):
 *         self.report_warning('... does not exist! Continuing without ffmpeg')
 *         return {}                              # nothing resolvable at all
 *
 * So leaving it unset is an active grant of PATH discovery, while a
 * nonexistent location yields an EMPTY executable map. `_paths` being empty
 * makes `_get_ffmpeg_version` return `(None, {})` via its `{None: None}` cache
 * seed — without even attempting a subprocess — so `basename` is None,
 * `available` is False, `probe_available` is False, and
 * `FFmpegFD.available()` (which delegates straight to
 * `FFmpegPostProcessor().available`) is False too.
 *
 * The value is a compile-time constant. It is never read from the request, the
 * environment, or configuration, so no caller and no user can point it at a
 * real binary.
 */
export const YTDLP_ANALYSIS_FFMPEG_LOCATION =
  "/nonexistent/videofetch-yt-dlp-analysis-no-ffmpeg";

/**
 * The COMPLETE environment for an analysis subprocess.
 *
 * Derived from the accepted Phase-10C1 closed environment — which is an
 * allowlist built from nothing, so no ambient variable survives — with PATH
 * replaced by a location that resolves nothing. The base environment is left
 * untouched for its existing callers, notably the diagnostics version probe,
 * which is a non-network invocation with no FFmpeg exposure to worry about.
 */
export function buildYtdlpAnalysisEnvironment(
  opts: { workDir?: string } = {},
): NodeJS.ProcessEnv {
  return Object.freeze({
    ...buildYtdlpEnvironment(opts),
    PATH: YTDLP_ANALYSIS_PATH,
  }) as NodeJS.ProcessEnv;
}

// ── Analysis argument policy ─────────────────────────────────────────────────

/**
 * Bounded network behaviour for a metadata-only run.
 *
 * yt-dlp 2026.08.19 defaults to `--retries 10`, `--extractor-retries 3` and no
 * socket timeout, which inside a ~45 s analysis budget means a single
 * unresponsive host can consume the entire window. These are fixed
 * application-owned constants; nothing here is caller- or user-supplied.
 */
const ANALYSIS_SOCKET_TIMEOUT_SECONDS = 10;
const ANALYSIS_RETRIES = 2;
const ANALYSIS_EXTRACTOR_RETRIES = 1;

/**
 * The analysis-specific argument policy, applied ON TOP of the closed Phase-10C1
 * base policy.
 *
 * Every option is verified against yt-dlp 2026.08.19's own `options.py`:
 *
 *   --dump-single-json     options.py: `'-J', '--dump-single-json'`
 *   --skip-download        options.py: `'--skip-download', '--no-download'`
 *   --no-progress          options.py: `'--no-progress'`
 *   --no-warnings          options.py: `'--no-warnings'`
 *   --no-cache-dir         options.py: `'--no-cache-dir'` -> `cachedir=False`
 *   --socket-timeout       options.py: `'--socket-timeout'`, type float
 *   --retries              options.py: `'-R', '--retries'`
 *   --extractor-retries    options.py: `'--extractor-retries'`
 *
 * `--skip-download` is passed even though `-J` already implies simulation
 * (`dump_single_json` is a member of `any_getting` in `yt_dlp/__init__.py`, so
 * `simulate` resolves true). Stating it explicitly means a future change to
 * either mechanism cannot quietly turn analysis into acquisition.
 *
 * Deliberately ABSENT, and asserted absent by tests: `-o`/`--output`, `-P`,
 * `-f`/`--format`, `--merge-output-format`, `--remux-video`, `-x`, every
 * `--write-*` side file, `--download-archive`, `--download-sections`,
 * `--wait-for-video`, and every credential/proxy/header option.
 */
export function ytdlpAnalysisPolicyArgs(): readonly string[] {
  return Object.freeze([
    // ── result shape ─────────────────────────────────────────────────────
    // One JSON document on stdout. NOTE: per its own help text, this dumps a
    // whole PLAYLIST as one object when the URL refers to one, so it does not
    // by itself enforce the single-item contract. `parseAnalysisInfo` does.
    "--dump-single-json",

    // ── no acquisition ───────────────────────────────────────────────────
    "--skip-download",

    // ── quiet, parseable output ──────────────────────────────────────────
    // `-J` already implies --quiet; these keep stray progress/warning lines
    // off the streams the parser and classifier read.
    "--no-progress",
    "--no-warnings",

    // ── no filesystem residue ────────────────────────────────────────────
    // Without this yt-dlp may write client ids and signatures under
    // ${XDG_CACHE_HOME}/yt-dlp. The environment already points that at an
    // unwritable sentinel; this removes the behaviour rather than relying on
    // the write failing.
    "--no-cache-dir",

    // ── bounded network behaviour ────────────────────────────────────────
    `--socket-timeout=${ANALYSIS_SOCKET_TIMEOUT_SECONDS}`,
    `--retries=${ANALYSIS_RETRIES}`,
    `--extractor-retries=${ANALYSIS_EXTRACTOR_RETRIES}`,

    // ── FFmpeg/ffprobe denial ────────────────────────────────────────────
    // Points yt-dlp at a fixed nonexistent location so it treats FFmpeg and
    // ffprobe as UNAVAILABLE. Leaving this unset is not neutral: the pinned
    // release then resolves both by bare name through PATH. See
    // YTDLP_ANALYSIS_FFMPEG_LOCATION for the exact upstream evidence.
    //
    // This is one of two independent mechanisms; the other is the analysis
    // PATH, which resolves nothing at all.
    `--ffmpeg-location=${YTDLP_ANALYSIS_FFMPEG_LOCATION}`,
  ] as const);
}

/**
 * The COMPLETE argv for one analysis run.
 *
 * The URL is the sole variable element and is always the final positional
 * argument, placed after a bare `--`. Both the base `optparse` parser and
 * yt-dlp's own `parse_known_args` override handle `--` explicitly and stop
 * option processing there, so a URL beginning with `-` or `--` is a URL and
 * cannot be read as an option, an alias, or an option's value.
 */
export function buildYtdlpAnalysisArgv(validatedUrl: string): readonly string[] {
  return Object.freeze([
    YTDLP_RUNTIME.artifactPath,
    ...ytdlpPolicyArgs(),
    ...ytdlpAnalysisPolicyArgs(),
    "--",
    validatedUrl,
  ]);
}

// ── Raw JSON validation ──────────────────────────────────────────────────────

/**
 * The subset of a yt-dlp format object this module is willing to read.
 *
 * Zod strips unknown keys, so this is an allowlist by construction: a field
 * absent from this schema cannot become application data no matter what the
 * extractor emits.
 *
 * ─── `format_id` and the Phase-10C3 change (§10) ────────────────────────────
 *
 * Phase-10C2 deliberately did NOT parse `format_id`, and could therefore claim
 * that no variable anywhere held one. That claim was only affordable because
 * execution did not exist: with no download path, there was nothing to select.
 *
 * Phase 10C3 acquires media, so the Worker must be able to name the exact
 * source it approved. The field is parsed here and the governing rule replaces
 * the old one:
 *
 *   A raw yt-dlp `format_id` may exist only inside a private Worker
 *   execution-analysis structure. It is never browser-facing, never durable,
 *   never request-controlled, never logged, and never passed to yt-dlp without
 *   strict validation and application-owned selector construction.
 *
 * Concretely, within this module the value can only ever reach
 * `GenericSourceSelection` (private, returned by `analyzeGenericMediaInternal`
 * alone). `WorkerVideoMetadata` still exposes `formats: []` and preset ids that
 * are application-owned literals, so the public result is unchanged.
 */
const RawFormatSchema = z.object({
  format_id: z.string().nullish(),
  ext: z.string().nullish(),
  height: z.number().finite().nullish(),
  width: z.number().finite().nullish(),
  fps: z.number().finite().nullish(),
  vcodec: z.string().nullish(),
  acodec: z.string().nullish(),
  filesize: z.number().finite().nullish(),
  filesize_approx: z.number().finite().nullish(),
  protocol: z.string().nullish(),
  format_note: z.string().nullish(),
  /**
   * A yt-dlp SORTING helper, not a stream-presence flag.
   *
   * `_fill_sorting_fields` sets `audio_ext = "none"` on EVERY format whose
   * `vcodec != "none"`, so a perfectly ordinary muxed video arrives carrying
   * `audio_ext: "none"`. It is parsed here only so regressions can assert that
   * classification is unaffected by it; nothing may read it as evidence about
   * whether a format carries audio, in either direction (§5).
   */
  audio_ext: z.string().nullish(),
  /**
   * The normalized source SHAPE the same function derives: `video_ext = ext`
   * unless the format is explicitly audio-only, in which case `"none"`.
   *
   * Unlike `audio_ext` this one IS load-bearing, but only as corroborating
   * shape evidence — never as a codec. It is what lets an UNKNOWN `vcodec`
   * establish a video-bearing source (§6), and what makes a contradiction
   * against a stated `vcodec` fail closed (§7).
   */
  video_ext: z.string().nullish(),
});
type RawFormat = z.infer<typeof RawFormatSchema>;

/**
 * The subset of a yt-dlp info document this module is willing to read.
 *
 * `entries` is declared as `unknown` purely so its PRESENCE is observable:
 * without a declaration Zod would strip it and the multi-video check below
 * could never fire.
 *
 * `title` is intentionally unbounded HERE and truncated later. A very long
 * title is not malformed input, and rejecting the whole analysis over one
 * would be a worse outcome than bounding the string.
 */
const RawInfoSchema = z.object({
  _type: z.string().nullish(),
  title: z.string().nullish(),
  duration: z.number().finite().nullish(),
  is_live: z.boolean().nullish(),
  live_status: z.string().nullish(),
  entries: z.unknown().optional(),
  formats: z.array(RawFormatSchema).nullish(),
  ext: z.string().nullish(),
});
type RawInfo = z.infer<typeof RawInfoSchema>;

/** Why a result was refused. Stable, non-secret, safe to test against. */
export type AnalysisRejection =
  | "malformed_json"
  | "invalid_shape"
  | "not_single_video"
  | "multi_entry"
  | "live_source"
  | "too_many_formats";

export type AnalysisParseResult =
  | { readonly ok: true; readonly info: RawInfo }
  | { readonly ok: false; readonly rejection: AnalysisRejection };

/**
 * Validates one `-J` document down to a single, non-live media item.
 *
 * The single-item gate is `_type === "video"` EXACTLY. This is reliable in the
 * pinned release because `YoutubeDL.sanitize_info` — the function that produces
 * every `-J` document — calls `info_dict.setdefault('_type', 'video')`, so the
 * key is always present and always explicit. A playlist, channel or feed
 * carries `playlist`; a multi-part show carries `multi_video`; an unresolved
 * indirection carries `url` or `url_transparent`. Every one of those is
 * refused, as is any value this module does not recognize: an unknown shape is
 * rejected rather than guessed at.
 */
export function parseAnalysisInfo(stdout: string): AnalysisParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, rejection: "malformed_json" };
  }

  const checked = RawInfoSchema.safeParse(parsed);
  if (!checked.success) return { ok: false, rejection: "invalid_shape" };
  const info = checked.data;

  // Single-item contract, primary gate.
  if (info._type !== "video") return { ok: false, rejection: "not_single_video" };

  // Single-item contract, independent second gate. `--no-playlist` is defence
  // in depth only (it is not even consulted for playlist-only URLs), and a
  // `video` result has no business carrying entries, so their presence means
  // the document is not the single item it claims to be.
  if (info.entries !== undefined && info.entries !== null) {
    return { ok: false, rejection: "multi_entry" };
  }

  // Live and wait-for-media states.
  if (info.is_live === true) return { ok: false, rejection: "live_source" };
  if (
    typeof info.live_status === "string" &&
    (YTDLP_REJECTED_LIVE_STATUSES as readonly string[]).includes(info.live_status)
  ) {
    return { ok: false, rejection: "live_source" };
  }

  // Post-parse collection bound. The stdout ceiling is what actually limits
  // memory; this bounds the application structures built from the document.
  if ((info.formats?.length ?? 0) > YTDLP_ANALYSIS_MAX_RAW_FORMATS) {
    return { ok: false, rejection: "too_many_formats" };
  }

  return { ok: true, info };
}

// ── Candidate selection ──────────────────────────────────────────────────────

type Candidate = {
  readonly hasVideo: boolean;
  /**
   * Audio presence is PROVEN: exactly `audioConstraint === "codec-present"`.
   * Every audio claim a generic preset makes is gated on this, so an unknown
   * audio state can never be advertised as carrying audio. `false` means "not
   * proven", never "proven absent" — that distinction lives in
   * `audioConstraint` alone.
   */
  readonly hasAudio: boolean;
  readonly height: number | null;
  readonly fps: number | null;
  /** Allowlisted SOURCE container. Never a defaulted or arbitrary extension. */
  readonly container: GenericSourceContainer;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly fileSize: number | null;
  /**
   * PRIVATE. The one raw upstream identifier this candidate was approved with,
   * already proven to satisfy the safe grammar. It exists so execution can name
   * the exact source it approved; it must never leave this module except inside
   * a `GenericSourceSelection`.
   */
  readonly formatId: string;
  /** PRIVATE. The acquisition protocol this candidate was approved on. */
  readonly protocol: GenericSourceProtocol;
  /**
   * PRIVATE. HOW video presence was established, so the acquisition selector
   * can bind the same evidence rather than assuming a known codec (§11).
   */
  readonly videoConstraint: GenericVideoConstraint;
  /**
   * PRIVATE. WHAT analysis knew about audio — `classifyCodecState(acodec)`,
   * one-for-one — so the acquisition selector can re-select the same state
   * instead of rebuilding it from the narrower `hasAudio` boolean.
   */
  readonly audioConstraint: GenericAudioConstraint;
  /** Position in the upstream list. The final, fully deterministic tiebreak. */
  readonly index: number;
};

/** Projects a candidate into the private execution descriptor. */
function toSelection(c: Candidate): GenericSourceSelection {
  return GenericSourceSelectionSchema.parse({
    formatId: c.formatId,
    protocol: c.protocol,
    container: c.container,
    hasVideo: c.hasVideo,
    hasAudio: c.hasAudio,
    videoConstraint: c.videoConstraint,
    audioConstraint: c.audioConstraint,
    fileSize: c.fileSize,
  });
}

/**
 * Wraps one candidate as a SINGLE-source preset fulfilment.
 *
 * SPLIT-01 made the per-preset value a discriminated union so that a preset may
 * instead be fulfilled by a video-only + audio-only pair. This is the half that
 * names exactly ONE upstream source; `toSplitSource` is the other half.
 */
function toSingleSource(c: Candidate): GenericPresetSource {
  return { kind: "single", source: toSelection(c) };
}

/**
 * Projects a video-only candidate and its audio-only partner into a validated
 * SPLIT preset fulfilment, or `null` when they are not a pair (SPLIT-05 §11).
 *
 * `GenericSplitSourceSelectionSchema` is the FINAL authority on pair validity,
 * and it is invoked here rather than re-stated: video present, video audio
 * proven absent, audio video proven absent, audio proven present, two different
 * upstream ids, and a container combination in the closed table. A rejection is
 * answered by returning `null` — the pair simply does not exist — never by
 * catching and weakening it.
 *
 * Both members are built by the SAME `toSelection` conversion single-source
 * selections use, so a pair member can never be a differently-shaped descriptor
 * that happens to satisfy the pair schema.
 */
function toSplitSource(video: Candidate, audio: Candidate): GenericPresetSource | null {
  const pair = GenericSplitSourceSelectionSchema.safeParse({
    video: toSelection(video),
    audio: toSelection(audio),
  });
  return pair.success ? { kind: "split", pair: pair.data } : null;
}

/**
 * The three states a yt-dlp codec field can actually be in.
 *
 * Collapsing these to a boolean is the root of both Phase-10D generic defects,
 * so they are named explicitly and never conflated (§4/§49):
 *
 *   PRESENT   a real codec string. The stream is proven to exist.
 *   ABSENT    the exact marker `"none"`. yt-dlp is stating that the stream is
 *             NOT there. This is the ONLY value that proves absence.
 *   UNKNOWN   `null`, `undefined`, `""` or the string `"null"`. The extractor
 *             did not tell us the codec identity. It is emphatically NOT a
 *             statement that the stream is missing — the Generic HTML5 path
 *             reaches exactly this state for a perfectly ordinary muxed mp4.
 *
 * "unknown is not absent" is the whole point: `vcodec = null` says we do not
 * know the codec; `vcodec = "none"` says there is no video stream.
 */
export type CodecState = "present" | "absent" | "unknown";

/**
 * Classifies one raw codec field.
 *
 * Surrounding whitespace and letter case are folded before comparison. The
 * pinned runtime emits exactly lowercase `none`, so folding changes nothing for
 * real output; it exists so an odd upstream variant such as `"NONE"` is read as
 * the absence marker it plainly is rather than as a codec literally named
 * "NONE". Both directions of that fold are the conservative one: it can only
 * ever withdraw a stream-presence claim, never manufacture one.
 */
export function classifyCodecState(codec: string | null | undefined): CodecState {
  if (typeof codec !== "string") return "unknown";
  const normalized = codec.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "null") return "unknown";
  if (normalized === "none") return "absent";
  return "present";
}

function isPresentCodec(codec: string | null | undefined): boolean {
  return classifyCodecState(codec) === "present";
}

/**
 * Maps a classified `acodec` onto the private audio constraint, one-for-one.
 *
 * Deliberately total and lossless: unknown stays unknown. Collapsing it to
 * `absent` is what made the selector unable to re-select the very format it
 * came from, and collapsing it to `codec-present` would claim audio that
 * nothing proves (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001).
 */
function toAudioConstraint(state: CodecState): GenericAudioConstraint {
  switch (state) {
    case "present":
      return "codec-present";
    case "absent":
      return "absent";
    case "unknown":
      return "unknown";
  }
}

/** Folds a raw container/extension field for comparison, or null when absent. */
function normalizeExtField(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

/** Normalizes a codec string to a small closed vocabulary, or null. */
export function normalizeCodecName(codec: string | null | undefined): string | null {
  if (!isPresentCodec(codec) || typeof codec !== "string") return null;
  const c = codec.toLowerCase();
  if (c.startsWith("avc") || c.includes("h264")) return "h264";
  if (c.includes("av01") || c.includes("av1")) return "av1";
  if (c.includes("vp09") || c.includes("vp9")) return "vp9";
  if (c.includes("vp8")) return "vp8";
  if (c.includes("hev") || c.includes("h265") || c.includes("hevc")) return "h265";
  if (c.includes("mp4a") || c.includes("aac")) return "aac";
  if (c.includes("opus")) return "opus";
  if (c.includes("mp3")) return "mp3";
  if (c.includes("vorbis")) return "vorbis";
  if (c.includes("flac")) return "flac";
  // Unknown codecs keep only their leading component, bounded.
  return (c.split(".")[0] ?? c).slice(0, 32);
}

/**
 * Turns validated raw formats into the v1-eligible candidate set.
 *
 * A format is eligible only when ALL of the following hold. Every one of them
 * is a boundary the generic DOWNLOAD path must also honour, so an ineligible
 * format is never advertised even though analysis itself could describe it
 * perfectly well. "Advertise only what can actually be acquired" is the rule:
 * a preset that would fail at download time is worse than an absent one,
 * because the user has already chosen it by then.
 *
 *   1. its protocol is explicitly `http` or `https` (see YTDLP_V1_NATIVE_PROTOCOLS);
 *   2. its upstream `format_id` satisfies the safe literal grammar (§11);
 *   3. its container is in the closed source allowlist for its stream shape (§15);
 *   4. it carries video, audio, or both — an empty format describes nothing;
 *   5. its VIDEO shape is establishable as exactly one of the three approved
 *      constraints, with no contradiction between `vcodec` and `video_ext`;
 *   6. any KNOWN size is within the configured maximum.
 *
 * Requirement 1 is deliberately strict about ABSENCE too: a format with no
 * `protocol` field is not eligible. yt-dlp derives a missing protocol from the
 * media URL at download time, which analysis cannot do without trusting an
 * upstream URL, and an unknown acquisition mode is exactly the ambiguity the
 * single-item/native-acquisition rules say to refuse rather than guess.
 *
 * Requirement 5 is the Phase-10D correction. Codec fields are read as three
 * states rather than two (see `classifyCodecState`), because the pinned runtime
 * distinguishes "there is no video stream" (`vcodec == "none"`) from "we did
 * not report the codec" (`vcodec == null`) — and conflating them made every
 * real Generic HTML5 source ineligible. An unestablishable or self-contradicting
 * video shape makes the whole format ineligible rather than being downgraded to
 * a weaker claim, because a claim the acquisition selector cannot re-select is
 * a preset that fails after the user has already chosen it.
 */
export function selectCandidates(
  formats: readonly RawFormat[],
  limits: { readonly maxFileSizeBytes: number },
): Candidate[] {
  const out: Candidate[] = [];
  formats.forEach((raw, index) => {
    const protocol = typeof raw.protocol === "string" ? raw.protocol.toLowerCase() : null;
    if (protocol === null) return;
    if (!(YTDLP_V1_NATIVE_PROTOCOLS as readonly string[]).includes(protocol)) return;

    // §11: a candidate whose upstream identifier does not satisfy the approved
    // literal grammar is NOT executable, so it must not be advertised either.
    // Advertising a preset the download path would refuse to acquire would move
    // the failure from analysis (where it is one clear FORMAT_UNAVAILABLE) to
    // mid-job, after the user already chose it.
    if (!isSafeFormatId(raw.format_id)) return;
    const formatId = raw.format_id;

    const note = (raw.format_note ?? "").toLowerCase();
    if (note.includes("storyboard") || note.includes("preview image")) return;

    // ── Audio presence ───────────────────────────────────────────────────
    //
    // `acodec` is the SOLE authority (§5). `audio_ext` takes no part, in either
    // direction, because `_fill_sorting_fields` in the pinned release sets it
    // to "none" on EVERY format whose `vcodec != "none"`:
    //
    //     else:
    //         format['video_ext'] = format['ext']
    //         format['audio_ext'] = 'none'
    //
    // It is a sorting/container helper, not a muxed-audio-presence flag. Gating
    // on it made `hasVideo && hasAudio` structurally impossible for real output
    // from ANY site, so no generic video preset could ever be built (§D1).
    //
    // The three states survive as they are. `hasAudio` is the NARROWER
    // statement — audio is PROVEN — so unknown is `false` there while staying
    // `unknown` in the private constraint; it is never rewritten as absent to
    // fit the boolean. Nothing correlational (container, `tbr`, `abr`, `asr`,
    // `audio_channels`, `format_note`) substitutes for a present `acodec`.
    const audioConstraint = toAudioConstraint(classifyCodecState(raw.acodec));
    const hasAudio = audioConstraint === "codec-present";

    // ── Video presence ───────────────────────────────────────────────────
    //
    // Three inputs, in decreasing order of authority: the codec state, the
    // normalized `video_ext` shape, and the source `ext`. A candidate becomes
    // executable only when they agree; where they contradict each other the
    // format is refused outright rather than resolved in whichever direction
    // happens to make it usable (§7).
    const videoState = classifyCodecState(raw.vcodec);
    const sourceExt = normalizeExtField(raw.ext);
    const videoExt = normalizeExtField(raw.video_ext);

    let videoConstraint: GenericVideoConstraint;
    if (videoState === "present") {
      // A named video codec alongside `video_ext: "none"` is a contradiction:
      // one field says the stream exists, the other says the normalized shape
      // has no video part. Neither may be preferred over the other.
      if (videoExt === "none") return;
      videoConstraint = "codec-present";
    } else if (videoState === "absent") {
      // Proven audio-only. `video_ext` may be absent (hand-written documents)
      // or "none" (real pinned output); anything else contradicts `vcodec`.
      if (videoExt !== null && videoExt !== "none") return;
      videoConstraint = "absent";
    } else {
      // UNKNOWN codec identity. Do NOT invent a codec, and do NOT read this as
      // absence. Video may be established here only from coherent source-shape
      // evidence (§6): `video_ext` must be a real container, it must equal the
      // source `ext`, and that container must be in the generic VIDEO
      // allowlist. This is the pinned Generic HTML5 case, where
      // `_parse_html5_media_entries` clobbers the parsed `vcodec` with `None`
      // via `f.update(formats[0])` (§D2).
      const coherent =
        videoExt !== null &&
        videoExt !== "none" &&
        sourceExt !== null &&
        videoExt === sourceExt &&
        (GENERIC_VIDEO_SOURCE_CONTAINERS as readonly string[]).includes(sourceExt);
      // Without that evidence the video shape is simply not established. It is
      // NOT downgraded to `absent`: claiming absence would emit a
      // `[vcodec="none"]` constraint that the real (null-vcodec) format could
      // never satisfy, so the Worker would advertise a preset acquisition is
      // guaranteed to fail on. Refusing the candidate is the honest outcome
      // and keeps "advertise only what can actually be acquired" true (§8).
      if (!coherent) return;
      videoConstraint = "video-ext";
    }

    const hasVideo = videoConstraint !== "absent";
    if (!hasVideo && !hasAudio) return;

    // §15: the source container comes from a closed allowlist, chosen by stream
    // shape, and an unknown or absent extension is a REJECTION rather than a
    // silent default to mp4. The value becomes a real file suffix, a MIME
    // decision and an `[ext=...]` selector constraint, so guessing it would
    // make all three wrong at once. This also subsumes the old non-media
    // extension denylist: storyboards, images and subtitle tracks simply are
    // not in the allowlist.
    const container = toGenericSourceContainer(raw.ext, { hasVideo });
    if (container === null) return;

    // A known size already over the limit must not be advertised. An UNKNOWN
    // size is not a rejection: the download path enforces an actual byte limit
    // independently, and metadata size is not a security boundary.
    const fileSize =
      typeof raw.filesize === "number" && raw.filesize > 0
        ? raw.filesize
        : typeof raw.filesize_approx === "number" && raw.filesize_approx > 0
          ? raw.filesize_approx
          : null;
    if (fileSize !== null && fileSize > limits.maxFileSizeBytes) return;

    out.push({
      hasVideo,
      hasAudio,
      height: typeof raw.height === "number" && raw.height > 0 ? Math.floor(raw.height) : null,
      fps: typeof raw.fps === "number" && raw.fps > 0 ? Math.round(raw.fps * 100) / 100 : null,
      container,
      videoCodec: hasVideo ? normalizeCodecName(raw.vcodec) : null,
      audioCodec: hasAudio ? normalizeCodecName(raw.acodec) : null,
      fileSize,
      formatId,
      protocol: protocol as GenericSourceProtocol,
      videoConstraint,
      audioConstraint,
      index,
    });
  });
  return out;
}

/**
 * Ranks two candidates WITHIN one resolution bucket. Lower sorts first.
 *
 * Resolution is never traded away here, because ranking only ever runs inside a
 * single bucket: a 1080p candidate is compared against other 1080p candidates
 * and never against a 720p one, whatever their codecs. Within a bucket the
 * order is container, then video codec, then audio codec, then the larger known
 * size, then higher fps, then upstream position — total and deterministic, with
 * no reliance on sort stability.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const containerRank = (c: Candidate) => (c.container === "mp4" ? 0 : c.container === "m4a" ? 1 : c.container === "webm" ? 2 : 3);
  const videoRank = (c: Candidate) => {
    switch (c.videoCodec) {
      case "h264":
        return 0;
      case "h265":
        return 1;
      case "vp9":
        return 2;
      case "av1":
        return 3;
      default:
        return 4;
    }
  };
  const audioRank = (c: Candidate) => {
    switch (c.audioCodec) {
      case "aac":
        return 0;
      case "mp3":
        return 1;
      case "opus":
        return 2;
      default:
        return 3;
    }
  };

  return (
    containerRank(a) - containerRank(b) ||
    videoRank(a) - videoRank(b) ||
    audioRank(a) - audioRank(b) ||
    (b.fileSize ?? 0) - (a.fileSize ?? 0) ||
    (b.fps ?? 0) - (a.fps ?? 0) ||
    a.index - b.index
  );
}

function bestOf(candidates: readonly Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareCandidates)[0] ?? null;
}

// ── Split pairing (SPLIT-05) ─────────────────────────────────────────────────

/**
 * Is this candidate usable as the VIDEO half of a split pair? (§6)
 *
 * All four conditions are stated explicitly rather than being collapsed into
 * `hasVideo && !hasAudio`, because the last one is the whole point:
 * `audioConstraint === "absent"` means yt-dlp SAID there is no audio stream.
 * An `unknown` audio state is `hasAudio: false` too, and it is NOT video-only —
 * it is a source whose audio nothing established either way. Promoting it here
 * because doing so would form a pair is exactly the collapse
 * GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001 exists to prevent: the pair would
 * acquire audio twice and then discard the source's own track via the stream
 * map, a substitution the user never asked for (§29).
 */
function isSplitVideoCandidate(c: Candidate): boolean {
  return (
    c.hasVideo &&
    c.videoConstraint !== "absent" &&
    c.hasAudio === false &&
    c.audioConstraint === "absent"
  );
}

/**
 * Is this candidate usable as the AUDIO half of a split pair? (§6/§30)
 *
 * Video must be PROVEN absent, not merely unknown: an unknown-video partner
 * might actually carry video, in which case the "pair" is not a split pair at
 * all. Audio must be PROVEN present, which is the same standard every existing
 * generic audio preset already requires.
 */
function isSplitAudioCandidate(c: Candidate): boolean {
  return (
    c.hasVideo === false &&
    c.videoConstraint === "absent" &&
    c.hasAudio &&
    c.audioConstraint === "codec-present"
  );
}

/**
 * The closed pairing families, expressed as VIDEO container -> AUDIO container.
 *
 * Deliberately the same two rows as `splitTargetContainer`'s table, stated here
 * as the PARTNER-SELECTION vocabulary rather than re-derived from it. The table
 * remains the authority on validity: every pair these families propose is still
 * validated through `GenericSplitSourceSelectionSchema`, so widening this list
 * alone can never widen what is actually mergeable.
 */
const SPLIT_FAMILIES = Object.freeze([
  Object.freeze({ video: "mp4", audio: "m4a" }),
  Object.freeze({ video: "webm", audio: "webm" }),
] as const);

/**
 * The PAIR-level known-size gate, and the public size a split preset advertises.
 *
 * `selectCandidates` already refused either half individually over the ceiling;
 * this is the additional check a pair needs, because two halves that each fit
 * can still be too large together (§13).
 *
 *   both sizes known   -> the exact sum, gated against the ceiling. The sum must
 *                         be a safe integer: beyond 2^53 an addition silently
 *                         stops being exact, and a budget decision made on an
 *                         inexact number is not a decision.
 *   either unknown     -> advertisable, with a public `fileSize` of `null` (§14).
 *                         No estimate is invented, and the pair is not refused:
 *                         SPLIT-03 enforces ACTUAL bytes against a combined
 *                         budget, which is the real security boundary. Metadata
 *                         size never was one.
 */
function pairKnownSize(
  video: Candidate,
  audio: Candidate,
  maxFileSizeBytes: number,
): { readonly advertisable: boolean; readonly fileSize: number | null } {
  if (video.fileSize === null || audio.fileSize === null) {
    return { advertisable: true, fileSize: null };
  }
  const combined = video.fileSize + audio.fileSize;
  if (!Number.isSafeInteger(combined)) return { advertisable: false, fileSize: null };
  if (combined > maxFileSizeBytes) return { advertisable: false, fileSize: null };
  return { advertisable: true, fileSize: combined };
}

/**
 * ONE advertisable VIDEO rendition, however it is fulfilled (§17).
 *
 * The abstraction exists so that ranking, bucketing and preset construction see
 * one kind of thing. A split pair is deliberately NOT squeezed into the shape of
 * a single `Candidate`: doing so would need a synthetic candidate carrying one
 * half's id and the other half's codec, which is precisely the drift the private
 * source descriptor exists to prevent.
 *
 * `video` is the common ranking input for both kinds — the audio partner has no
 * say in resolution (§22) and, being fixed per family, no say in ordering (§25).
 * `targetContainer` and `fileSize` are the FINAL public values, derived once
 * here so no later step has to re-decide them.
 */
type VideoFulfillment =
  | {
      readonly kind: "single";
      readonly video: Candidate;
      readonly source: GenericPresetSource;
      readonly targetContainer: GenericSourceContainer;
      readonly fileSize: number | null;
    }
  | {
      readonly kind: "split";
      readonly video: Candidate;
      readonly audio: Candidate;
      readonly source: GenericPresetSource;
      readonly targetContainer: GenericSplitTargetContainer;
      readonly fileSize: number | null;
    };

/**
 * Ranks two fulfilments WITHIN one resolution bucket. Lower sorts first.
 *
 * Exactly like `compareCandidates`, resolution is never traded away here,
 * because ranking only ever runs inside one bucket.
 *
 * KIND OUTRANKS EVERYTHING ELSE (§24). At equal resolution a muxed source wins
 * over a pair whatever its container, codec, size or fps, because one-source
 * delivery needs no merge at all: fewer acquisitions, no local FFmpeg work, and
 * no second way for the job to fail. The preference is only ever paid for with
 * things other than quality — a higher-resolution split still beats a lower
 * muxed rendition, which is decided by bucketing before this function is
 * reached (§23).
 *
 * Below kind, both cases defer to the EXISTING candidate ranking on the video
 * half, so single-vs-single ordering is byte-for-byte what it was, and
 * split-vs-split ordering introduces no second policy. It stays total: the only
 * way two fulfilments could share a video candidate is one being muxed and the
 * other video-only, which one candidate cannot be at once.
 */
function compareFulfillments(a: VideoFulfillment, b: VideoFulfillment): number {
  const kindRank = (f: VideoFulfillment) => (f.kind === "single" ? 0 : 1);
  return kindRank(a) - kindRank(b) || compareCandidates(a.video, b.video);
}

function bestFulfillment(fulfillments: readonly VideoFulfillment[]): VideoFulfillment | null {
  if (fulfillments.length === 0) return null;
  return [...fulfillments].sort(compareFulfillments)[0] ?? null;
}

/**
 * Is this candidate a MUXED video source: video plus PROVEN audio, in one file?
 *
 * The only single-source shape the proven video tier accepts, and the only
 * video-bearing shape Worker FFmpeg may extract audio from. `hasAudio` is
 * exactly `audioConstraint === "codec-present"` (see `selectCandidates`), so an
 * unknown-audio source is never muxed as far as advertising is concerned.
 */
function isMuxedVideoCandidate(c: Candidate): boolean {
  return c.hasVideo && c.hasAudio;
}

/**
 * Is this candidate usable as an UNKNOWN-AUDIO single video source?
 * (GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001)
 *
 * Video is established, and nothing establishes audio EITHER way: `acodec` was
 * missing, null, empty or `"null"`. Every eligibility gate in `selectCandidates`
 * has already been passed — protocol, safe id, container, coherent video shape,
 * known size — so this adds no admission of its own; it only names the shape.
 *
 * All four conditions are stated explicitly, mirroring `isSplitVideoCandidate`,
 * because the unknown-vs-absent distinction is the whole point. An `absent`
 * audio state is `hasAudio: false` too, and it is deliberately NOT accepted
 * here: a proven video-only rendition stays governed by the split rules alone,
 * and ordinary silent-video advertising is outside this capability.
 */
function isUnknownAudioVideoCandidate(c: Candidate): boolean {
  return (
    c.hasVideo &&
    c.videoConstraint !== "absent" &&
    c.hasAudio === false &&
    c.audioConstraint === "unknown"
  );
}

/**
 * Builds every advertisable VIDEO fulfilment backed by PROVEN audio.
 *
 * Muxed candidates become `single` fulfilments unconditionally, exactly as
 * before. Split fulfilments are additionally built only when the WORKER's own
 * FFmpeg is available (§8), because the merge is Worker-local work performed
 * after `beginProcessing()` commits — yt-dlp is never asked to merge, and the
 * absence of Worker FFmpeg is never answered by widening yt-dlp's authority.
 *
 * ONE audio partner is chosen per family, for the WHOLE result (§9), and there
 * is no alternate-partner fallback (§10): a video candidate that cannot pair
 * with its family's partner simply has no split fulfilment. Scanning lower-
 * ranked audio tracks until one fit would make the advertised audio depend on
 * which video rung the user picked, which is per-preset source substitution by
 * another name.
 */
function buildProvenVideoFulfillments(
  candidates: readonly Candidate[],
  opts: { readonly ffmpegAvailable: boolean; readonly maxFileSizeBytes: number },
): VideoFulfillment[] {
  // Muxed single-source video candidates only — video plus PROVEN audio. An
  // unknown-audio candidate is not muxed as far as advertising is concerned.
  const muxedVideo = candidates.filter(isMuxedVideoCandidate);

  const fulfillments: VideoFulfillment[] = muxedVideo.map((c) => ({
    kind: "single",
    video: c,
    source: toSingleSource(c),
    targetContainer: c.container,
    fileSize: c.fileSize,
  }));

  if (!opts.ffmpegAvailable) return fulfillments;

  // The ONE partner per family, chosen once, by the existing deterministic
  // candidate ranking. Keyed by the VIDEO container it serves.
  const audioOnly = candidates.filter(isSplitAudioCandidate);
  const partners = new Map<GenericSourceContainer, Candidate>();
  for (const family of SPLIT_FAMILIES) {
    const partner = bestOf(audioOnly.filter((c) => c.container === family.audio));
    if (partner) partners.set(family.video, partner);
  }

  for (const video of candidates.filter(isSplitVideoCandidate)) {
    const audio = partners.get(video.container);
    if (!audio) continue;

    // The target is derived from the closed table and from nowhere else, so a
    // family row that drifted from the table produces no pair rather than a
    // pair with an invented target (§19).
    const targetContainer = splitTargetContainer(video.container, audio.container);
    if (targetContainer === null) continue;

    const size = pairKnownSize(video, audio, opts.maxFileSizeBytes);
    if (!size.advertisable) continue;

    // The schema is the last word. A rejection reduces capability; it is never
    // caught and worked around (§11).
    const source = toSplitSource(video, audio);
    if (source === null) continue;

    fulfillments.push({
      kind: "split",
      video,
      audio,
      source,
      targetContainer,
      fileSize: size.fileSize,
    });
  }

  return fulfillments;
}

/**
 * Chooses the ONE video fulfilment tier the whole result advertises from
 * (GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001).
 *
 *   proven    every muxed and split fulfilment, exactly as before this task.
 *   unknown   ONLY when the proven tier is EMPTY: every single progressive
 *             candidate whose video is established and whose audio is unknown.
 *
 * The tier is chosen for the WHOLE result, never per rung. The moment any
 * proven fulfilment exists, unknown-audio candidates affect no video preset at
 * all — not `preset:best`, not an otherwise-empty rung — so every source that
 * was advertisable before keeps a byte-identical preset list. A higher-resolution
 * unknown source never displaces a lower proven one, because "has audio" is not
 * a property the user should silently lose by picking a sharper rung.
 *
 * The proven tier depends on Worker FFmpeg (a pair needs its merge), so a
 * result whose ONLY proven fulfilment was a pair has an empty proven tier when
 * FFmpeg is unavailable, and the unknown tier may then engage. That is
 * intentional: the pair cannot be offered, and the unknown source is exactly as
 * deliverable as it is anywhere else.
 *
 * Fallback fulfilments are ordinary `single` fulfilments, ranked by the same
 * `compareFulfillments` → `compareCandidates` path. Within the unknown tier every
 * candidate is single with a null audio codec, so ranking is exactly the
 * existing single-source video ranking; nothing site-specific is added.
 */
function selectVideoFulfillments(
  candidates: readonly Candidate[],
  opts: { readonly ffmpegAvailable: boolean; readonly maxFileSizeBytes: number },
): VideoFulfillment[] {
  const proven = buildProvenVideoFulfillments(candidates, opts);
  if (proven.length > 0) return proven;

  return candidates.filter(isUnknownAudioVideoCandidate).map((c) => ({
    kind: "single",
    video: c,
    source: toSingleSource(c),
    targetContainer: c.container,
    fileSize: c.fileSize,
  }));
}

/**
 * The result of preset construction: the browser-safe presets, plus the PRIVATE
 * per-preset source selections execution needs.
 *
 * The two are produced together so they cannot drift: a preset with no
 * selection would be unacquirable, and a selection with no preset would be
 * unreachable.
 */
export type GenericPresetBuild = {
  readonly presets: WorkerQualityPreset[];
  readonly selections: GenericSourceSelections;
};

/**
 * Builds the generic preset list.
 *
 * VIDEO presets come from two kinds of fulfilment, ranked together (SPLIT-05):
 *
 *   - a MUXED candidate carrying video AND proven audio in ONE source, which is
 *     the only kind that existed before SPLIT-05 and is unchanged here;
 *   - an approved video-only + audio-only PAIR, merged LOCALLY by the Worker's
 *     own FFmpeg after `beginProcessing()` commits.
 *
 * The browser is told nothing about which. Both produce an ordinary
 * application-owned preset — `preset:1080` is `preset:1080` — because how a
 * rendition is fulfilled is a Worker implementation detail and the public
 * vocabulary is closed (§12/§20/§21).
 *
 * yt-dlp still performs NO merge. `+` appears in no selector, its FFmpeg stays
 * unresolvable, and each half of a pair is acquired by its own independent
 * single-source invocation (§52).
 *
 * AUDIO presets are unchanged and remain SINGLE-source (§28): an audio-only
 * source kept verbatim, or a muxed source the Worker extracts from with its own
 * FFmpeg. A pair's chosen audio partner may well also be the best ordinary
 * audio-only candidate — that is the same candidate winning two independent
 * rankings, not a coupling.
 *
 * "Carries audio" still means PROVEN audio: `hasAudio`, i.e. an
 * `audioConstraint` of `codec-present`. A source whose `acodec` is unknown is
 * never advertised as muxed video, as a split video half, as audio, or as MP3,
 * because nothing establishes that it has an audio stream at all
 * (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001, §29).
 *
 * It MAY back an ordinary VIDEO preset as a whole-result FALLBACK tier, used
 * only when no proven video fulfilment exists (see `selectVideoFulfillments`;
 * GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001). Such a preset states
 * `hasAudio: false` and `audioCodec: null`, which for a generic preset means
 * "audio is not proven", never "audio is proven absent"; the private selection
 * keeps `audioConstraint: "unknown"`, which is the only place the distinction
 * lives. `analyzeGenericMediaInternal` asserts every emitted preset/selection
 * pair against the rule for its shape (`assertGenericPresetBuild`).
 *
 * `maxFileSizeBytes` is needed for the PAIR-level combined-size gate (§13/§16).
 * It is injected rather than imported so this module still cannot reach
 * process-wide configuration and tests can vary it without mutating global
 * state.
 */
export function buildGenericPresets(
  candidates: readonly Candidate[],
  opts: { readonly ffmpegAvailable: boolean; readonly maxFileSizeBytes: number },
): GenericPresetBuild {
  const presets: WorkerQualityPreset[] = [];
  // PRIVATE, and parallel to `presets` by construction: every preset pushed
  // below records the exact candidate it was derived from, in the same step.
  // Keeping the two together is what lets execution re-find the approved source
  // without re-deriving it from the browser-facing preset, which carries no
  // upstream identity at all.
  const selections: Record<string, GenericPresetSource> = {};

  // Muxed single-source video candidates only — video plus PROVEN audio. Also
  // the only video-bearing sources audio may be extracted from, below.
  const muxedVideo = candidates.filter(isMuxedVideoCandidate);

  // Every advertisable video rendition of the ONE tier this result uses: muxed
  // and split alike, ranked together — or, only when neither exists, the
  // unknown-audio singles.
  const videoFulfillments = selectVideoFulfillments(candidates, opts);

  const videoPreset = (
    id: string,
    label: string,
    resolution: string | null,
    f: VideoFulfillment,
  ): WorkerQualityPreset => ((selections[id] = f.source), {
    id,
    label,
    resolution,
    // The FINAL container: the source's own for a muxed fulfilment, the closed
    // table's derived target for a pair. Never a second, independently guessed
    // value (§20/§75).
    container: f.targetContainer,
    // Combined known size for a pair, the source's own size for a muxed
    // fulfilment, `null` when anything is unknown (§15).
    fileSize: f.fileSize,
    hasVideo: true,
    // DERIVED from the member that would carry the audio stream — the single
    // source itself, or the pair's AUDIO member — never hard-coded. That member's
    // `hasAudio` is PROVEN audio, so this is `true` for a muxed source and for
    // every pair, and `false` for an unknown-audio fallback source, whose audio
    // is simply not proven. It is never a claim of absence.
    hasAudio: f.kind === "single" ? f.video.hasAudio : f.audio.hasAudio,
    // The product contract is `id === formatId`, and both are
    // application-owned. No upstream identifier is involved in either — a pair
    // holds two of them, and neither appears here (§12).
    formatId: id,
    videoCodec: f.video.videoCodec,
    // The half that actually carries the stream: the muxed source itself, or
    // the pair's AUDIO member. `null` for an unknown-audio source, whose
    // candidate carries no audio codec because none was proven.
    audioCodec: f.kind === "single" ? f.video.audioCodec : f.audio.audioCodec,
    fps: f.video.fps,
  });

  // "Best available" is the winner of the highest bucket that has one, so it
  // can never be a lower resolution than a named preset that is also offered.
  // Resolution dominates ACROSS buckets, so a 1080p pair beats a 720p muxed
  // source here; kind only decides ties WITHIN one bucket (§23/§24).
  const bucketed = RESOLUTION_STEPS.map((step) => ({
    step,
    best: bestFulfillment(
      videoFulfillments.filter((f) => f.video.height !== null && f.video.height >= step.minHeight),
    ),
  }));

  const overallBest = bucketed.find((b) => b.best !== null);
  if (overallBest?.best) {
    presets.push(
      videoPreset("preset:best", "Best available", overallBest.step.resolution, overallBest.best),
    );
  } else {
    // No height information anywhere, but a usable fulfilment exists: offer it
    // as "best" with an unknown resolution rather than dropping video whole.
    // Single still outranks split at equivalent unknown height (§27).
    const anyVideo = bestFulfillment(videoFulfillments);
    if (anyVideo) presets.push(videoPreset("preset:best", "Best available", null, anyVideo));
  }

  // Named ladder rungs. Each rung is the best fulfilment AT that height exactly,
  // so a 1080p source does not also masquerade as the 720p option. A pair's
  // bucket comes from its VIDEO half; the audio partner has no say (§22/§26).
  for (const step of RESOLUTION_STEPS) {
    const inBucket = videoFulfillments.filter((f) => {
      const height = f.video.height;
      if (height === null) return false;
      if (height < step.minHeight) return false;
      // Exactly this rung: a taller source belongs to a higher rung only.
      return !RESOLUTION_STEPS.some((s) => s.minHeight > step.minHeight && height >= s.minHeight);
    });
    const best = bestFulfillment(inBucket);
    if (best) presets.push(videoPreset(step.id, step.label, step.resolution, best));
  }

  // Audio. An audio-ONLY source needs no local processing; a muxed source needs
  // Worker FFmpeg, so it is offered only when FFmpeg is actually available.
  //
  // Deliberately UNTOUCHED by SPLIT-05 (§28). The audio presets keep their own
  // ranking and stay `kind: "single"`: a merge is only ever how a VIDEO preset
  // gets its audio. When a pair's family partner also wins here, that is the
  // same candidate winning two independent rankings — not a coupling, and not a
  // shared selection.
  //
  // Equally UNTOUCHED by the unknown-audio video tier. Both source pools below
  // require PROVEN audio (`hasAudio`), so an unknown-audio candidate — even one
  // currently backing every video preset — can never become an audio or MP3
  // source: extracting from a silent file is a `PROCESSING_FAILED`, not a
  // download.
  const audioOnly = candidates.filter((c) => c.hasAudio && !c.hasVideo);
  const bestAudioOnly = bestOf(audioOnly);
  const audioSource = bestAudioOnly ?? (opts.ffmpegAvailable ? bestOf(muxedVideo) : null);

  if (audioSource) {
    // The SOURCE is `audioSource`; the ADVERTISED container may differ from it
    // (a muxed source advertised as m4a is extracted by the Worker's own FFmpeg
    // after `processing` begins, never by yt-dlp).
    selections["preset:audio"] = toSingleSource(audioSource);
    presets.push({
      id: "preset:audio",
      label: "Audio only",
      resolution: "audio",
      container: bestAudioOnly ? bestAudioOnly.container : "m4a",
      fileSize: bestAudioOnly ? bestAudioOnly.fileSize : null,
      hasVideo: false,
      hasAudio: true,
      formatId: "preset:audio",
      videoCodec: null,
      audioCodec: audioSource.audioCodec,
      fps: null,
    });

    // MP3 is always a Worker-side transcode, so it needs FFmpeg regardless of
    // which kind of source was chosen.
    if (opts.ffmpegAvailable) {
      selections["preset:mp3"] = toSingleSource(audioSource);
      presets.push({
        id: "preset:mp3",
        label: "Audio only (MP3)",
        resolution: "audio",
        container: "mp3",
        fileSize: null,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:mp3",
        videoCodec: null,
        audioCodec: "mp3",
        fps: null,
      });
    }
  }

  return { presets, selections };
}

/**
 * Structural assertions on preset construction's OWN output.
 *
 * These cannot be triggered by upstream data; they exist so that a future edit
 * which widened the preset vocabulary, leaked an upstream identifier, or quietly
 * widened what the Worker can acquire fails loudly HERE — as one canonical
 * `EXTRACTION_FAILED` — rather than silently at the browser or mid-job.
 *
 * The audio rules are SHAPE-AWARE, not relaxed. Each preset is checked against
 * the private selection behind it, with the rule that actually applies to that
 * pairing:
 *
 *   `preset:audio` / `preset:mp3`   one source with PROVEN audio. Unchanged.
 *   video preset, one source        the public `hasAudio` equals the private
 *                                   PROOF, and the private state is exactly
 *                                   `codec-present` (true) or `unknown` (false,
 *                                   with no audio codec). `absent` is a split
 *                                   half's shape and is refused as a single.
 *   video preset, pair              public `hasAudio: true`; the pair invariants.
 *
 * Writing this as one flat "every selection has proven audio" check would be
 * wrong in both directions: it would reject every valid split pair and every
 * unknown-audio fallback preset, and the obvious "fix" for that — dropping the
 * check — would let an unknown or absent audio state reach an audio product, or
 * a public audio claim drift from its proof, unnoticed.
 *
 * The unknown-audio tier is additionally asserted to be a FALLBACK: it may not
 * coexist with a proven-backed video preset, and it may not be used at all when
 * the candidate set has a proven video fulfilment to offer
 * (GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001).
 */
export function assertGenericPresetBuild(
  build: GenericPresetBuild,
  context: {
    readonly candidates: readonly Candidate[];
    readonly ffmpegAvailable: boolean;
    readonly maxFileSizeBytes: number;
  },
): void {
  const { presets, selections } = build;
  const fail = (): never => {
    throw new AppError("EXTRACTION_FAILED");
  };

  if (presets.length > YTDLP_ANALYSIS_MAX_PRESETS) fail();
  for (const preset of presets) {
    if (!GENERIC_PRESET_ID_PATTERN.test(preset.id)) fail();
    if (preset.formatId !== preset.id) fail();
    // Every advertised preset must be acquirable. A preset without a private
    // selection could only fail later, after the user had chosen it.
    if (!selections[preset.id]) fail();
  }
  // ...and nothing may be selectable that was never advertised.
  for (const id of Object.keys(selections)) {
    if (!presets.some((p) => p.id === id)) fail();
  }

  let provenVideoPresets = 0;
  let unknownAudioVideoPresets = 0;

  for (const preset of presets) {
    const value = selections[preset.id]!;
    const audioProduct = preset.id === "preset:audio" || preset.id === "preset:mp3";

    if (value.kind === "single") {
      const source = value.source;

      if (audioProduct) {
        // An audio product is built on PROVEN audio and on nothing else. An
        // unknown source here would be an extraction from a file that may well
        // be silent (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001).
        if (preset.hasVideo !== false || preset.hasAudio !== true) fail();
        if (source.audioConstraint !== "codec-present" || source.hasAudio !== true) fail();
        continue;
      }

      // An ordinary VIDEO preset fulfilled by ONE source.
      if (preset.hasVideo !== true) fail();
      if (source.hasVideo !== true || source.videoConstraint === "absent") fail();
      // The public audio claim IS the private proof — in both directions. A
      // proven source behind `false` would hide audio the user is getting; an
      // unproven source behind `true` would promise audio nothing established.
      if (preset.hasAudio !== source.hasAudio) fail();

      switch (source.audioConstraint) {
        case "codec-present":
          if (source.hasAudio !== true) fail();
          provenVideoPresets += 1;
          break;
        case "unknown":
          if (source.hasAudio !== false || preset.audioCodec !== null) fail();
          unknownAudioVideoPresets += 1;
          break;
        default:
          // `absent`: proven video-only. That is a split pair's VIDEO half, and
          // advertising it as an ordinary single video is outside this
          // capability — whatever the public boolean would have said.
          fail();
      }
      continue;
    }

    // ── SPLIT (SPLIT-05 §33) ──────────────────────────────────────────────────
    //
    // SPLIT-01 fail-closed here unconditionally, because no acquisition or merge
    // path existed. SPLIT-02..04 built that path, so the unconditional rejection
    // is replaced by the assertions that actually apply to a pair — not removed.

    // A merge is only ever how a VIDEO preset gets its audio, and a pair always
    // carries proven audio through its audio member.
    if (audioProduct) fail();
    if (preset.hasVideo !== true || preset.hasAudio !== true) fail();

    // `GenericSplitSourceSelectionSchema` is invoked rather than re-implemented:
    // it is the authority on all six pair invariants (video present, video audio
    // proven absent, audio video proven absent, audio proven present, different
    // upstream ids, closed container combination), and re-deriving them here
    // would create a second, driftable copy of the rules.
    if (!GenericSplitSourceSelectionSchema.safeParse(value.pair).success) fail();

    // Restated at THIS level, deliberately and narrowly: the two unknown-vs-absent
    // facts are the ones a future relaxation would be most tempted to soften, and
    // they are the ones that make a pair a pair rather than a silent substitution
    // (§29/§30). The container table and the id-difference are left to the schema
    // alone, which is the only place they are stated.
    if (value.pair.video.audioConstraint !== "absent") fail();
    if (value.pair.audio.videoConstraint !== "absent") fail();
    if (value.pair.audio.audioConstraint !== "codec-present") fail();

    // A pair can only be fulfilled by the Worker's OWN FFmpeg. Advertising one
    // without it would promise a merge nothing can perform (§8). Construction is
    // already gated on this; asserting it makes the gate a property of the
    // analyzer's output rather than of one filter inside preset building.
    if (!context.ffmpegAvailable) fail();

    provenVideoPresets += 1;
  }

  // The unknown-audio tier is a FALLBACK for the whole result. It may not share
  // the video ladder with a proven-backed rung, and it may not be used while the
  // candidates offer ANY proven video fulfilment — advertised or not — because
  // that is exactly the case in which it must affect no video preset at all.
  if (unknownAudioVideoPresets > 0) {
    if (provenVideoPresets > 0) fail();
    if (buildProvenVideoFulfillments(context.candidates, context).length > 0) fail();
  }
}

// ── Sanitization ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- matching control characters is this regex's entire purpose
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * Bounds and cleans an upstream string before it becomes returned metadata.
 *
 * Control characters are replaced rather than escaped: they have no legitimate
 * place in a title and are the raw material for terminal-escape and log-forging
 * payloads. They collapse to a SPACE rather than to nothing, because deleting
 * them outright welds words together across a line break — a title of
 * "Chapter one\nThe beginning" would otherwise render as "Chapter oneThe
 * beginning". The subsequent whitespace collapse absorbs the runs this creates.
 */
export function sanitizeUpstreamText(
  value: string | null | undefined,
  maxLength: number,
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, maxLength);
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Maps a failed run to a canonical Worker error code.
 *
 * This is a small, deliberately shallow classifier over a handful of stable
 * upstream phrases. It is NOT the legacy `mapExtractorMessage`: that one is a
 * large regex taxonomy whose branches return `AppError`s carrying text derived
 * from the input, which is precisely what must not cross this boundary.
 *
 * The contract here is narrow: raw text goes IN, a canonical code comes OUT,
 * and the text is never stored, logged or attached to the returned error.
 * Anything unrecognized collapses to `EXTRACTION_FAILED`.
 */
export function classifyAnalysisFailure(rawStderr: string): AppError["code"] {
  const text = rawStderr.toLowerCase();

  if (text.includes("unsupported url") || text.includes("no suitable extractor")) {
    return "UNSUPPORTED_SITE";
  }
  if (
    text.includes("private video") ||
    text.includes("video unavailable") ||
    text.includes("has been removed") ||
    text.includes("account associated with this video has been terminated") ||
    text.includes("sign in") ||
    text.includes("login required") ||
    text.includes("members-only") ||
    text.includes("age-restricted") ||
    text.includes("this video is not available")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (text.includes("no video formats found") || text.includes("requested format is not available")) {
    return "FORMAT_UNAVAILABLE";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    text.includes("unable to download webpage") ||
    text.includes("connection refused") ||
    text.includes("connection reset") ||
    text.includes("temporary failure in name resolution") ||
    text.includes("network is unreachable")
  ) {
    return "NETWORK_ERROR";
  }
  return "EXTRACTION_FAILED";
}

// ── The analyzer ─────────────────────────────────────────────────────────────

/**
 * The narrow limits slice the analyzer needs.
 *
 * Deliberately a small injected object rather than an import of the legacy
 * global `@/lib/config`: this module must not be able to reach Vercel-era
 * configuration, and tests must be able to vary the bounds without mutating
 * process-wide state.
 */
export type GenericAnalysisLimits = {
  readonly analysisTimeoutSeconds: number;
  readonly maxVideoDurationSeconds: number;
  readonly maxFileSizeBytes: number;
};

export type GenericAnalysisDeps = {
  readonly limits: GenericAnalysisLimits;
  /** Whether the Worker's OWN FFmpeg is usable for post-`downloading` work. */
  readonly ffmpegAvailable?: boolean;
  readonly signal?: AbortSignal;
  /** Test seams. Production uses the real hardened runner, probe and clock. */
  readonly runner?: typeof runProcess;
  readonly probeRuntime?: (opts: YtdlpProbeOptions) => Promise<YtdlpRuntimeStatus>;
  readonly validateUrl?: (raw: string) => Promise<{ url: string; hostname: string }>;
  /**
   * Monotonic-enough millisecond clock for the shared subprocess deadline.
   * Injectable so budget arithmetic can be tested without real sleeps.
   */
  readonly clock?: () => number;
};

/**
 * The EXECUTION-side analysis result (§9).
 *
 * `video` is exactly what the browser may see. `selections` is the private
 * half: one validated source descriptor per advertised preset, each carrying
 * the raw upstream `format_id` the Worker approved.
 *
 * This type is returned by `analyzeGenericMediaInternal` and by nothing else.
 * `selections` must never cross Worker HTTP, enter `WorkerVideoMetadata`, enter
 * SQLite, reach Vercel or the browser, be logged, or appear in an error.
 */
export type GenericInternalAnalysis = {
  readonly video: WorkerVideoMetadata;
  readonly selections: GenericSourceSelections;
};

/**
 * Analyzes one generic URL with the pinned yt-dlp runtime, returning BOTH the
 * browser-safe metadata and the private execution selections.
 *
 * Callers on the HTTP path must use `analyzeGenericMedia` instead, which drops
 * the private half.
 *
 * Order of operations is a security property, not a style choice:
 *
 *   1. validate the request shape;
 *   2. run the Worker's own URL/SSRF validation;
 *   3. verify the EXACT pinned runtime;
 *   4. only then start a network-capable subprocess.
 *
 * Steps 1 and 2 complete before ANY process is spawned — the version probe
 * included — so an unsafe or malformed URL causes zero yt-dlp processes, zero
 * Node/EJS descendants, and no DNS or TCP activity attributable to it.
 *
 * Step 3 exists because a user URL must never be executed by an unverified
 * runtime. A missing, mismatched, malformed or unrunnable yt-dlp fails closed
 * as `EXTRACTOR_UNAVAILABLE` rather than falling back to whatever is on disk.
 *
 * The initial URL check is defence in depth and NOT a claim about yt-dlp's own
 * networking: once running, yt-dlp issues its own secondary requests, follows
 * its own redirects, and fetches manifests, fragments and extractor APIs that
 * this validation never sees. Those are constrained in Production by the
 * external media network namespace, its nftables policy and the watchdog — an
 * architecture this module deliberately does not restate as a boolean.
 */
export async function analyzeGenericMediaInternal(
  url: string,
  deps: GenericAnalysisDeps,
): Promise<GenericInternalAnalysis> {
  const runner = deps.runner ?? runProcess;
  const probe = deps.probeRuntime ?? probeYtdlpRuntime;
  const validate = deps.validateUrl ?? assertSafeUrl;
  const clock = deps.clock ?? Date.now;

  // 1. Request shape. Rejected before anything is spawned.
  const shape = WorkerAnalyzeRequestSchema.safeParse({ url });
  if (!shape.success) throw new AppError("INVALID_URL");

  // 2. The Worker's own URL/SSRF validation. Also before anything is spawned.
  //    Its AppErrors (INVALID_URL, NETWORK_ERROR) propagate unchanged.
  const { url: safeUrl, hostname } = await validate(shape.data.url);

  // 3. One deadline for the WHOLE subprocess phase.
  //
  //    `analysisTimeoutSeconds` is the caller's budget for analyzing this URL,
  //    not a per-subprocess allowance. The probe and the network analysis
  //    therefore share it: giving the network run a fresh full budget after the
  //    probe had already spent part of one would let the pair take up to twice
  //    what the configuration permits.
  const budgetMs = Math.max(
    YTDLP_ANALYSIS_MIN_TIMEOUT_MS,
    Math.floor(deps.limits.analysisTimeoutSeconds * 1000),
  );
  const deadline = clock() + budgetMs;

  // An already-cancelled caller gets no subprocess at all — not even the probe.
  // The runner would refuse to spawn anyway, but checking here makes "nothing
  // was started" a property of this function rather than of its dependencies.
  if (deps.signal?.aborted) {
    throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
  }

  // 4. Exact pinned-runtime gate. Only now may a process exist at all, and this
  //    one is the non-network version probe. It is capped by whichever is
  //    smaller: its own conservative maximum, or what is left of the budget.
  const probeBudgetMs = Math.min(YTDLP_PROBE_TIMEOUT_MS, deadline - clock());
  if (probeBudgetMs <= 0) throw new AppError("TIMEOUT");

  const runtime = await probe({ signal: deps.signal, timeoutMs: probeBudgetMs });
  if (!runtime.available) throw new AppError("EXTRACTOR_UNAVAILABLE");

  // 5. Generic network analysis, with only the REMAINING budget. If the probe
  //    consumed all of it, the network-capable subprocess is never started.
  const networkTimeoutMs = deadline - clock();
  if (networkTimeoutMs <= 0) throw new AppError("TIMEOUT");

  let result: RunResult;
  try {
    result = await runner({
      command: YTDLP_RUNTIME.pythonPath,
      args: [...buildYtdlpAnalysisArgv(safeUrl)],
      timeoutMs: networkTimeoutMs,
      // The analysis-specific environment, whose PATH resolves nothing. This is
      // NOT the shared base environment: that one keeps /usr/bin on PATH, where
      // this image's ffmpeg and ffprobe live.
      env: buildYtdlpAnalysisEnvironment(),
      signal: deps.signal,
      maxStdoutBytes: YTDLP_ANALYSIS_MAX_STDOUT_BYTES,
      maxStderrBytes: YTDLP_ANALYSIS_MAX_STDERR_BYTES,
    });
  } catch (err: unknown) {
    // Cancellation propagates verbatim so a caller can tell it apart.
    if (deps.signal?.aborted) throw err;
    if (err instanceof ProcessOutputLimitError) {
      // Over-limit output is never parsed and never described. The process
      // group is already terminated by the runner.
      throw new AppError("EXTRACTION_FAILED");
    }
    if (err instanceof AppError && err.code === "TIMEOUT") throw new AppError("TIMEOUT");
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  }

  if (result.code !== 0) {
    // stderr is read here and NOWHERE else: classified into a canonical code
    // and then dropped with the RunResult. It is never logged, persisted,
    // attached to the thrown error, or returned.
    throw new AppError(classifyAnalysisFailure(result.stderr));
  }

  const parsed = parseAnalysisInfo(result.stdout);
  if (!parsed.ok) {
    switch (parsed.rejection) {
      case "live_source":
        // Live and wait-for-media sources are out of scope for Phase-10 v1;
        // this also protects the recorded FFmpeg acquisition boundary.
        throw new AppError("VIDEO_UNAVAILABLE");
      case "not_single_video":
      case "multi_entry":
        // Playlists, channels, feeds and multi-video shows are a separate
        // product feature, not a failure of this one.
        throw new AppError("UNSUPPORTED_SITE");
      default:
        throw new AppError("EXTRACTION_FAILED");
    }
  }

  const info = parsed.info;

  // Duration bound, enforced before any metadata is returned. An UNKNOWN
  // duration stays null and is not a rejection.
  const duration = typeof info.duration === "number" && info.duration > 0 ? info.duration : null;
  if (duration !== null && duration > deps.limits.maxVideoDurationSeconds) {
    throw new AppError("TOO_LONG");
  }

  const candidates = selectCandidates(info.formats ?? [], deps.limits);
  const ffmpegAvailable = deps.ffmpegAvailable ?? false;
  const { presets, selections } = buildGenericPresets(candidates, {
    ffmpegAvailable,
    // The PAIR-level combined-size budget (§13/§16). The same ceiling
    // `selectCandidates` already applied to each half individually.
    maxFileSizeBytes: deps.limits.maxFileSizeBytes,
  });

  // Structural and shape-aware audio assertions on this module's OWN output,
  // including the fallback-only rule for the unknown-audio video tier. Any
  // violation is one canonical EXTRACTION_FAILED; see `assertGenericPresetBuild`.
  assertGenericPresetBuild(
    { presets, selections },
    { candidates, ffmpegAvailable, maxFileSizeBytes: deps.limits.maxFileSizeBytes },
  );

  const video = VideoMetadataSchema.parse({
    title: sanitizeUpstreamText(info.title, YTDLP_ANALYSIS_MAX_TITLE_LENGTH, "Video"),
    // Conservative Phase-10 v1 policy: an extractor-provided thumbnail URL is a
    // secondary network destination that would be handed straight to the
    // browser. No repository mechanism validates or proxies such a URL today,
    // so none is exposed. The resulting missing-thumbnail UX for generic
    // sources is intentional and recorded.
    thumbnail: null,
    duration,
    // Derived from the URL the WORKER validated, never from upstream.
    source: hostname,
    // The application-owned execution-strategy identity. Deliberately not the
    // upstream `extractor` / `extractor_key`, which is an arbitrary string the
    // source controls.
    extractor: "yt-dlp",
    // The validated submitted URL stays authoritative. Upstream `webpage_url`
    // and `original_url` are not parsed at all, so neither can override it.
    webpageUrl: safeUrl,
    // Phase-10 v1 exposes NO raw formats. The browser's advanced selector
    // echoes `formats[].id` back as `formatId`, so anything listed here would
    // become a browser-controlled selector in a later phase.
    formats: [],
    presets,
    capabilities: {
      mp3: presets.some((p) => p.id === "preset:mp3"),
      // SPLIT-05 §31: for GENERIC metadata, `merge` means exactly "at least one
      // preset advertised for THIS source is fulfilled by the approved
      // Worker-local split merge". It does NOT mean yt-dlp may merge — yt-dlp
      // merges nothing, here or anywhere else on this path — nor that the
      // browser may submit raw split selectors, nor that every item needs a
      // merge.
      //
      // Derived from the FINAL selection map, so it can never claim a capability
      // the user cannot actually choose, and can never stay false while a
      // split-backed preset is on offer. A merely POSSIBLE but unselected pair
      // sets nothing.
      //
      // The `ffmpegAvailable` conjunction is redundant at runtime — split
      // construction is already gated on it, and the loop above re-asserts that
      // — and is retained because this is a PUBLIC capability claim, and it
      // should read as conditional on the thing that makes it true.
      merge:
        ffmpegAvailable && Object.values(selections).some((value) => value.kind === "split"),
    },
  });

  return { video, selections };
}

/**
 * The BROWSER-SAFE generic analyzer.
 *
 * Returns the validated public metadata and nothing else. The private source
 * selections are dropped here rather than merely "not used", so a caller on the
 * HTTP path cannot reach them even by accident — which is the whole point of
 * the split (§9).
 */
export async function analyzeGenericMedia(
  url: string,
  deps: GenericAnalysisDeps,
): Promise<WorkerVideoMetadata> {
  const internal = await analyzeGenericMediaInternal(url, deps);
  return internal.video;
}
