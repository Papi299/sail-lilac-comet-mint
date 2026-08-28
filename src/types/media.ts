export type ResolutionLabel =
  | "2160p"
  | "1440p"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
  | "240p"
  | "144p"
  | "audio"
  | "unknown";

export type NormalizedFormat = {
  id: string;
  resolution: ResolutionLabel | string;
  width: number | null;
  height: number | null;
  fps: number | null;
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  fileSize: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  formatNote?: string | null;
};

export type QualityPreset = {
  id: string;
  label: string;
  resolution: string | null;
  container: string;
  fileSize: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  formatId: string;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number | null;
};

export type VideoMetadata = {
  title: string;
  thumbnail: string | null;
  duration: number | null;
  source: string;
  extractor: string;
  webpageUrl: string;
  formats: NormalizedFormat[];
  presets: QualityPreset[];
  capabilities: {
    mp3: boolean;
    merge: boolean;
  };
};

export type AnalyzeSuccess = {
  success: true;
  video: VideoMetadata;
};

export type ApiErrorBody = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};
import { z } from "zod";

export const NormalizedFormatSchema = z.object({
  id: z.string(),
  resolution: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  fps: z.number().nullable(),
  container: z.string(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  bitrate: z.number().nullable(),
  fileSize: z.number().nullable(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  formatNote: z.string().nullable().optional(),
});

export const QualityPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  resolution: z.string().nullable(),
  container: z.string(),
  fileSize: z.number().nullable(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  formatId: z.string(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  fps: z.number().nullable(),
});

export const VideoMetadataSchema = z.object({
  title: z.string(),
  thumbnail: z.string().nullable(),
  duration: z.number().nullable(),
  source: z.string(),
  extractor: z.string(),
  webpageUrl: z.string(),
  formats: z.array(NormalizedFormatSchema),
  presets: z.array(QualityPresetSchema),
  capabilities: z.object({
    mp3: z.boolean(),
    merge: z.boolean(),
  }),
});
