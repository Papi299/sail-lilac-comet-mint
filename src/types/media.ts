// TYPE-ONLY: the authoritative P1 schema stays in the shared Worker contract,
// and this import erases from the browser bundle, so no Worker code ships.
import type {
  SourceQuality,
  SourceQualityWithheld,
  SourceQualityWithheldReason,
} from "@/shared/worker/contracts";

export type { SourceQuality, SourceQualityWithheld, SourceQualityWithheldReason };

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
  // What generic analysis OBSERVED versus what it can deliver. Informational
  // only: nothing selectable is ever derived from it. Direct analysis omits it.
  sourceQuality?: SourceQuality;
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
