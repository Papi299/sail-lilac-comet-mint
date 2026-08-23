import { stat } from "node:fs/promises";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { buildPresets, mimeForContainer } from "@/services/extractors/normalize";
import type { DownloadContext, DownloadResult, MediaExtractor } from "@/services/extractors/types";
import { convertMedia, ffmpegAvailable, generateSampleClip } from "@/services/processing/ffmpeg.server";
import type { NormalizedFormat, VideoMetadata } from "@/types/media";

const SAMPLE_FORMATS: NormalizedFormat[] = [
  {
    id: "sample-720",
    resolution: "720p",
    width: 1280,
    height: 720,
    fps: 24,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    bitrate: 1_200_000,
    fileSize: 400_000,
    hasVideo: true,
    hasAudio: true,
  },
  {
    id: "sample-audio",
    resolution: "audio",
    width: null,
    height: null,
    fps: null,
    container: "m4a",
    videoCodec: null,
    audioCodec: "aac",
    bitrate: 128_000,
    fileSize: 80_000,
    hasVideo: false,
    hasAudio: true,
  },
];

export const sampleExtractor: MediaExtractor = {
  id: "sample",
  name: "Sample clip",
  canHandle(url: string) {
    return /^sample:/i.test(url);
  },
  async getMetadata() {
    const mp3 = await ffmpegAvailable();
    return {
      title: "VideoFetch sample clip",
      thumbnail: null,
      duration: 5,
      source: "sample",
      extractor: "sample",
      webpageUrl: "sample://demo",
      formats: SAMPLE_FORMATS,
      presets: buildPresets(SAMPLE_FORMATS, { mp3 }),
      capabilities: { mp3, merge: mp3 },
    } satisfies VideoMetadata;
  },
  async getFormats() {
    return SAMPLE_FORMATS;
  },
  async download(_url, format, ctx: DownloadContext): Promise<DownloadResult> {
    ctx.onProgress?.({ progress: 10, stage: "processing" });
    const generated = await generateSampleClip(ctx.workDir, 30_000);
    ctx.onProgress?.({ progress: 70, stage: "processing" });
    let filePath = generated;
    let container = "mp4";
    if (format.formatId === "preset:mp3" || format.formatId === "preset:audio" || format.convertMp3) {
      const target = format.formatId === "preset:mp3" || format.convertMp3 ? "mp3" : "mp3";
      filePath = await convertMedia({
        inputPath: generated,
        workDir: ctx.workDir,
        target: target === "mp3" ? "mp3" : "mp3",
        timeoutMs: 30_000,
        signal: ctx.signal,
      });
      container = "mp3";
    }
    const st = await stat(filePath);
    if (st.size > config.maxFileSize) throw new AppError("TOO_LARGE");
    ctx.onProgress?.({ progress: 100, stage: "processing" });
    return {
      filePath,
      container,
      mime: mimeForContainer(container),
      fileSize: st.size,
      quality: container === "mp3" ? "audio" : "720p",
    };
  },
};
