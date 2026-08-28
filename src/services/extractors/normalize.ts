import type { NormalizedFormat, QualityPreset, ResolutionLabel } from "@/types/media";

const HEIGHT_STEPS: { min: number; label: ResolutionLabel }[] = [
  { min: 2160, label: "2160p" },
  { min: 1440, label: "1440p" },
  { min: 1080, label: "1080p" },
  { min: 720, label: "720p" },
  { min: 480, label: "480p" },
  { min: 360, label: "360p" },
  { min: 240, label: "240p" },
  { min: 144, label: "144p" },
];

export function resolutionFromHeight(height?: number | null): ResolutionLabel {
  if (!height || height <= 0) return "unknown";
  for (const step of HEIGHT_STEPS) {
    if (height >= step.min) return step.label;
  }
  return "144p";
}

function isNone(codec?: string | null): boolean {
  return !codec || codec === "none" || codec === "null";
}

const SKIP_EXTS = new Set(["mhtml", "storyboard", "jpg", "png", "webp", "mhtml_storyboard"]);

export type YtdlpFormat = {
  format_id?: string;
  ext?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  protocol?: string | null;
  format_note?: string | null;
  resolution?: string | null;
  audio_ext?: string | null;
  video_ext?: string | null;
};

export function normalizeYtdlpFormat(raw: YtdlpFormat): NormalizedFormat | null {
  const id = String(raw.format_id ?? "").trim();
  if (!id) return null;
  const ext = (raw.ext || "mp4").toLowerCase();
  if (SKIP_EXTS.has(ext)) return null;
  const note = (raw.format_note || "").toLowerCase();
  if (note.includes("storyboard") || note.includes("preview image")) return null;
  const protocol = (raw.protocol || "").toLowerCase();
  if (protocol.includes("mhtml")) return null;

  const hasVideo = !isNone(raw.vcodec) && raw.video_ext !== "none";
  const hasAudio = !isNone(raw.acodec) && raw.audio_ext !== "none";
  if (!hasVideo && !hasAudio) return null;

  const height = raw.height && raw.height > 0 ? raw.height : null;
  const width = raw.width && raw.width > 0 ? raw.width : null;
  const resolution = hasVideo ? resolutionFromHeight(height) : "audio";
  const bitrate =
    (raw.tbr ? raw.tbr * 1000 : null) ??
    (raw.vbr ? raw.vbr * 1000 : null) ??
    (raw.abr ? raw.abr * 1000 : null);

  return {
    id,
    resolution,
    width,
    height,
    fps: raw.fps && raw.fps > 0 ? Math.round(raw.fps * 100) / 100 : null,
    container: ext,
    videoCodec: hasVideo ? normalizeCodec(raw.vcodec) : null,
    audioCodec: hasAudio ? normalizeCodec(raw.acodec) : null,
    bitrate,
    fileSize: raw.filesize || raw.filesize_approx || null,
    hasVideo,
    hasAudio,
    formatNote: raw.format_note ?? null,
  };
}

export function normalizeCodec(codec?: string | null): string | null {
  if (!codec || isNone(codec)) return null;
  const c = codec.toLowerCase();
  if (c.startsWith("avc") || c.includes("h264")) return "h264";
  if (c.includes("av01") || c.includes("av1")) return "av1";
  if (c.includes("vp09") || c.includes("vp9")) return "vp9";
  if (c.includes("vp8")) return "vp8";
  if (c.includes("hev") || c.includes("h265") || c.includes("hevc")) return "h265";
  if (c.includes("mp4a") || c.includes("aac")) return "aac";
  if (c.includes("opus")) return "opus";
  if (c.includes("mp3") || c.includes("mp3")) return "mp3";
  if (c.includes("vorbis")) return "vorbis";
  if (c.includes("flac")) return "flac";
  return codec.split(".")[0] ?? codec;
}

function containerScore(container: string, videoCodec: string | null): number {
  const c = container.toLowerCase();
  if (c === "mp4" && (videoCodec === "h264" || videoCodec === null)) return 100;
  if (c === "mp4") return 80;
  if (c === "m4a") return 70;
  if (c === "webm") return 50;
  if (c === "mkv") return 40;
  return 10;
}

function codecScore(videoCodec: string | null, audioCodec: string | null): number {
  let score = 0;
  if (videoCodec === "h264") score += 40;
  else if (videoCodec === "vp9") score += 25;
  else if (videoCodec === "av1") score += 15;
  else if (videoCodec === "h265") score += 20;
  if (audioCodec === "aac") score += 20;
  else if (audioCodec === "mp3") score += 15;
  else if (audioCodec === "opus") score += 10;
  return score;
}

export function scoreFormat(format: NormalizedFormat): number {
  let score = 0;
  if (format.hasVideo && format.hasAudio) score += 200;
  else if (format.hasVideo) score += 80;
  else if (format.hasAudio) score += 60;
  score += containerScore(format.container, format.videoCodec);
  score += codecScore(format.videoCodec, format.audioCodec);
  if (format.fileSize) score += Math.min(20, format.fileSize / (50 * 1024 * 1024));
  if (format.bitrate) score += Math.min(15, format.bitrate / 1_000_000);
  return score;
}

export function pickBest(formats: NormalizedFormat[]): NormalizedFormat | null {
  if (!formats.length) return null;
  return [...formats].sort((a, b) => scoreFormat(b) - scoreFormat(a))[0] ?? null;
}

const PRESET_LABELS: Record<string, string> = {
  "2160p": "2160p / 4K",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  "360p": "360p",
  "240p": "240p",
  "144p": "144p",
};

export function buildPresets(
  formats: NormalizedFormat[],
  options: { mp3: boolean, ffmpeg?: boolean },
): QualityPreset[] {
  const videoFormats = formats.filter((f) => f.hasVideo);
  const audioFormats = formats.filter((f) => f.hasAudio && !f.hasVideo);
  const combinedOrVideo = formats.filter((f) => f.hasVideo);
  const presets: QualityPreset[] = [];

  const bestVideo = pickBest(combinedOrVideo);
  if (bestVideo) {
    const targetContainer = preferContainer(bestVideo);
    const requiresConversion = targetContainer !== bestVideo.container;
    const canConvert = requiresConversion ? (options.ffmpeg ?? options.mp3) : true;
    if (canConvert) {
      presets.push({
        id: "preset:best",
        label: "Best available",
        resolution: bestVideo.resolution,
        container: targetContainer,
        fileSize: bestVideo.fileSize,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:best",
        videoCodec: bestVideo.videoCodec,
        audioCodec: bestVideo.audioCodec,
        fps: bestVideo.fps,
      });
    }
  }

  const byRes = new Map<string, NormalizedFormat[]>();
  for (const format of videoFormats) {
    const key = format.resolution;
    const list = byRes.get(key) ?? [];
    list.push(format);
    byRes.set(key, list);
  }

  for (const step of HEIGHT_STEPS) {
    const group = byRes.get(step.label);
    if (!group?.length) continue;
    const best = pickBest(group);
    if (!best) continue;
    const targetContainer = preferContainer(best);
    const requiresConversion = targetContainer !== best.container;
    const canConvert = requiresConversion ? (options.ffmpeg ?? options.mp3) : true;
    if (canConvert) {
      presets.push({
        id: `preset:${step.min}`,
        label: PRESET_LABELS[step.label] ?? step.label,
        resolution: step.label,
        container: targetContainer,
        fileSize: best.fileSize,
        hasVideo: true,
        hasAudio: true,
        formatId: `preset:${step.min}`,
        videoCodec: best.videoCodec,
        audioCodec: best.audioCodec,
        fps: best.fps,
      });
    }
  }

  const bestAudio = pickBest(audioFormats.length ? audioFormats : formats.filter((f) => f.hasAudio));
  if (bestAudio) {
    const requiresConversion = bestAudio.hasVideo;
    const canExtract = requiresConversion ? options.ffmpeg ?? options.mp3 : true;
    if (canExtract) {
      presets.push({
        id: "preset:audio",
        label: "Audio only",
        resolution: "audio",
        container: bestAudio.hasVideo ? "m4a" : bestAudio.container,
        fileSize: bestAudio.fileSize,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:audio",
        videoCodec: null,
        audioCodec: bestAudio.audioCodec,
        fps: null,
      });
    }
    if (options.mp3) {
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

  return presets;
}

function preferContainer(format: NormalizedFormat): string {
  if (format.container === "mp4" || format.container === "m4a") return format.container;
  if (format.videoCodec === "h264" || format.videoCodec === "h265") return "mp4";
  if (format.container === "webm") return "webm";
  return "mp4";
}

export function ytDlpFormatSelector(formatId: string): {
  selector: string;
  extractAudio: boolean;
  audioFormat?: string;
  mergeFormat?: string;
  heightCap?: number;
} {
  if (formatId === "preset:best") {
    return { selector: "bv*+ba/b", extractAudio: false, mergeFormat: "mp4" };
  }
  if (formatId === "preset:audio") {
    return { selector: "ba/b", extractAudio: true };
  }
  if (formatId === "preset:mp3") {
    return { selector: "ba/b", extractAudio: true, audioFormat: "mp3" };
  }
  const preset = /^preset:(\d+)$/.exec(formatId);
  if (preset) {
    const height = Number(preset[1]);
    return {
      selector: `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`,
      extractAudio: false,
      mergeFormat: "mp4",
      heightCap: height,
    };
  }
  return { selector: formatId, extractAudio: false };
}

export function mimeForContainer(container: string): string {
  switch (container.toLowerCase()) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

export function parseYtdlpProgress(line: string): {
  progress: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speed: number | null;
  eta: number | null;
} | null {
  const percentMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (!percentMatch) {
    if (line.includes("[Merger]") || line.includes("[ExtractAudio]") || line.includes("[VideoConvertor]")) {
      return { progress: null, downloadedBytes: null, totalBytes: null, speed: null, eta: null };
    }
    return null;
  }
  const progress = Number(percentMatch[1]);
  const totalMatch = line.match(/of\s+~?\s*([\d.]+)\s*([KMG]i?B)/i);
  const speedMatch = line.match(/at\s+([\d.]+)\s*([KMG]i?B)\/s/i);
  const etaMatch = line.match(/ETA\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  const downloadedMatch = line.match(/(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)\s*([KMG]i?B)/i);

  const totalBytes = totalMatch ? parseSize(totalMatch[1], totalMatch[2]) : null;
  const downloadedBytes =
    totalBytes != null && Number.isFinite(progress) ? Math.round((progress / 100) * totalBytes) : null;
  const speed = speedMatch ? parseSize(speedMatch[1], speedMatch[2]) : null;
  let eta: number | null = null;
  if (etaMatch) {
    const a = Number(etaMatch[1]);
    const b = Number(etaMatch[2]);
    const c = etaMatch[3] != null ? Number(etaMatch[3]) : null;
    eta = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  void downloadedMatch;
  return { progress, downloadedBytes, totalBytes, speed, eta };
}

function parseSize(value: string, unit: string): number {
  const n = Number(value);
  const u = unit.toUpperCase();
  if (u.startsWith("KI")) return n * 1024;
  if (u.startsWith("K")) return n * 1000;
  if (u.startsWith("MI")) return n * 1024 * 1024;
  if (u.startsWith("M")) return n * 1000 * 1000;
  if (u.startsWith("GI")) return n * 1024 * 1024 * 1024;
  if (u.startsWith("G")) return n * 1000 * 1000 * 1000;
  return n;
}
