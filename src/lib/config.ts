import { tmpdir } from "node:os";
import { join } from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

export const config = {
  maxFileSize: num("MAX_FILE_SIZE", 500 * 1024 * 1024),
  maxVideoDuration: num("MAX_VIDEO_DURATION", 2 * 60 * 60),
  fileExpirationMinutes: num("FILE_EXPIRATION_MINUTES", 45),
  maxConcurrentDownloads: num("MAX_CONCURRENT_DOWNLOADS", 3),
  maxConcurrentPerIp: num("MAX_CONCURRENT_PER_IP", 2),
  rateLimitPerMinute: num("RATE_LIMIT", 20),
  tempDirectory: str("TEMP_DIRECTORY", join(tmpdir(), "videofetch")),
  ffmpegPath: str("FFMPEG_PATH", "/usr/local/bin/ffmpeg"),
  downloadTimeoutMs: num("DOWNLOAD_TIMEOUT", 600) * 1000,
  analysisTimeoutMs: num("ANALYSIS_TIMEOUT", 45) * 1000,
  maxRedirects: num("MAX_REDIRECTS", 5),
  diagnosticsToken: str("DIAGNOSTICS_TOKEN", ""),
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
