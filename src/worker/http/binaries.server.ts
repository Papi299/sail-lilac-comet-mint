import { ffmpegAvailable } from "../../services/processing/ffmpeg.server.ts";
import { ytdlpAvailable } from "../../services/extractors/ytdlp.server.ts";

export type WorkerBinaryReport = {
  ffmpeg: boolean;
  ytdlp: boolean;
};

export type WorkerBinaryProbe = () => Promise<WorkerBinaryReport>;

/**
 * Diagnostics-only binary presence probe.
 *
 * Both helpers execute the installed binary with a VERSION flag and nothing
 * else. No user-supplied URL, argument, or network target reaches either
 * process. This module is the ONLY Worker file permitted to reference the
 * yt-dlp binary at all, and it must never gain an extraction entry point
 * (Phase 10 owns yt-dlp user-URL execution).
 */
export const probeWorkerBinaries: WorkerBinaryProbe = async () => {
  const [ffmpeg, ytdlp] = await Promise.all([ffmpegAvailable(), ytdlpAvailable()]);
  return { ffmpeg, ytdlp };
};
