import { ffmpegAvailable } from "../../services/processing/ffmpeg.server.ts";
import { probeYtdlpRuntime } from "../runtime/ytdlp-runtime.server.ts";

export type WorkerBinaryReport = {
  ffmpeg: boolean;
  ytdlp: boolean;
  /** The exact version the pinned runtime reported, or null when unavailable. */
  ytdlpVersion: string | null;
};

export type WorkerBinaryProbe = () => Promise<WorkerBinaryReport>;

/**
 * Diagnostics-only binary presence probe.
 *
 * Both helpers execute an installed binary with a VERSION flag and nothing
 * else. No user-supplied URL, argument, or network target reaches either
 * process, and neither performs a media request.
 *
 * The yt-dlp half is served by the Worker's OWN runtime module
 * (`../runtime/ytdlp-runtime.server.ts`), which owns the pinned runtime
 * identity and the closed argument/environment policy. It deliberately does
 * NOT reach into the legacy `services/extractors/ytdlp.server.ts`: that module
 * is a Vercel-era extractor carrying analyze and download entry points, and
 * the Worker must not load it merely to ask for a version.
 *
 * This module must never gain an extraction entry point. `ytdlp: true` here
 * means the pinned runtime is executable — never that generic extraction is
 * permitted, which is a separate application feature state.
 */
export const probeWorkerBinaries: WorkerBinaryProbe = async () => {
  const [ffmpeg, ytdlp] = await Promise.all([ffmpegAvailable(), probeYtdlpRuntime()]);
  return { ffmpeg, ytdlp: ytdlp.available, ytdlpVersion: ytdlp.version };
};
