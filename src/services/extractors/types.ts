import type { NormalizedFormat, VideoMetadata } from "@/types/media";

export type DownloadFormatRequest = {
  formatId: string;
  preferredContainer?: string;
  audioOnly?: boolean;
  convertMp3?: boolean;
};

export type DownloadContext = {
  workDir: string;
  onProgress?: (update: {
    progress: number | null;
    downloadedBytes?: number | null;
    totalBytes?: number | null;
    speed?: number | null;
    eta?: number | null;
    stage?: string;
  }) => void;
  signal?: AbortSignal;
};

export type DownloadResult = {
  filePath: string;
  container: string;
  mime: string;
  fileSize: number;
  quality: string | null;
};

export interface MediaExtractor {
  id: string;
  name: string;
  canHandle(url: string): boolean;
  getMetadata(url: string): Promise<VideoMetadata>;
  getFormats(url: string): Promise<NormalizedFormat[]>;
  download(
    url: string,
    format: DownloadFormatRequest,
    ctx: DownloadContext,
  ): Promise<DownloadResult>;
}
