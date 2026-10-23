import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "@/shared/media-limits";

/**
 * This module's numeric rule, pure so it can be held against the strict Worker
 * loader (VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001).
 *
 * Unset, empty and whitespace-only all mean "use the fallback", exactly as the
 * strict loader's `optional()` reads them. A whitespace-only value used to
 * become `Number("  ") === 0` here — a zero byte ceiling, or a zero timeout,
 * where the strict loader applied the default. Nothing else changed: any other
 * value is `Number(raw)` when finite and non-negative, otherwise the fallback.
 */
export function parseLaxNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function num(name: string, fallback: number): number {
  return parseLaxNumber(process.env[name], fallback);
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

export const config = {
  // The SAME default the strict Worker runtime loader applies (4 GiB); both
  // read it from one shared constant so they cannot drift apart.
  maxFileSize: num("MAX_FILE_SIZE", DEFAULT_MAX_FILE_SIZE_BYTES),
  maxVideoDuration: num("MAX_VIDEO_DURATION", 2 * 60 * 60),
  fileExpirationMinutes: num("FILE_EXPIRATION_MINUTES", 45),
  maxConcurrentDownloads: num("MAX_CONCURRENT_DOWNLOADS", 3),
  maxConcurrentPerPrincipal: num("MAX_CONCURRENT_PER_PRINCIPAL", 2),
  rateLimitPerMinute: num("RATE_LIMIT", 20),
  tempDirectory: str("TEMP_DIRECTORY", join(tmpdir(), "videofetch")),
  ffmpegPath: str("FFMPEG_PATH", "/usr/local/bin/ffmpeg"),
  // The LEGACY in-process modules' download budget, and nothing else's. The
  // Worker's acquisition and processing limits come only from its strict loader
  // (`DOWNLOAD_TIME_LIMIT`, `PROCESSING_TIMEOUT`), which refuses
  // `DOWNLOAD_TIMEOUT` by presence; `worker-time-limits-boundary.test.ts`
  // keeps every Worker execution path off this value.
  downloadTimeoutMs: num("DOWNLOAD_TIMEOUT", 600) * 1000,
  analysisTimeoutMs: num("ANALYSIS_TIMEOUT", 45) * 1000,
  maxRedirects: num("MAX_REDIRECTS", 5),
  nodeEnv: str("NODE_ENV", "development"),
};

/**
 * Operator assertion that yt-dlp will run inside an independently enforced
 * safe-egress environment (private network namespace / egress filter).
 *
 * This flag is NOT itself an isolation boundary. Default is fail-closed.
 * Read at call time so tests can toggle it without reloading the module.
 */
export function isYtdlpNetworkIsolated(): boolean {
  const raw = process.env.YTDLP_NETWORK_ISOLATED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function resolveYtdlp(): { command: string; argsPrefix: string[] } {
  const explicit = process.env.YTDLP_PATH;
  if (explicit && explicit.length > 0) {
    const parts = explicit.split(" ").filter(Boolean);
    return { command: parts[0] ?? "python3", argsPrefix: parts.slice(1) };
  }
  return { command: "python3", argsPrefix: ["-m", "yt_dlp"] };
}

export function isProd(): boolean {
  return config.nodeEnv === "production";
}
