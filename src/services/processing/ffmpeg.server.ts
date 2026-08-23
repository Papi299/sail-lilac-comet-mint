import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { runProcess } from "@/services/processing/process-runner.server";

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await access(config.ffmpegPath);
    const result = await runProcess({
      command: config.ffmpegPath,
      args: ["-version"],
      timeoutMs: 8_000,
    });
    return (result.stdout + result.stderr).toLowerCase().includes("ffmpeg version");
  } catch {
    return false;
  }
}

export async function convertMedia(opts: {
  inputPath: string;
  workDir: string;
  target: "mp4" | "webm" | "mp3";
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: number | null) => void;
}): Promise<string> {
  const outName =
    opts.target === "mp3" ? "converted.mp3" : opts.target === "webm" ? "converted.webm" : "converted.mp4";
  const outputPath = join(opts.workDir, outName);
  const args =
    opts.target === "mp3"
      ? [
          "-y",
          "-nostdin",
          "-i",
          opts.inputPath,
          "-vn",
          "-c:a",
          "libmp3lame",
          "-q:a",
          "2",
          outputPath,
        ]
      : opts.target === "webm"
        ? [
            "-y",
            "-nostdin",
            "-i",
            opts.inputPath,
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "32",
            "-c:a",
            "libopus",
            outputPath,
          ]
        : [
            "-y",
            "-nostdin",
            "-i",
            opts.inputPath,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            outputPath,
          ];

  opts.onProgress?.(null);
  const result = await runProcess({
    command: config.ffmpegPath,
    args,
    timeoutMs: opts.timeoutMs,
    cwd: opts.workDir,
    signal: opts.signal,
  });
  if (result.code !== 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  opts.onProgress?.(100);
  return outputPath;
}

export async function remuxCopy(opts: {
  inputPath: string;
  workDir: string;
  ext: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const outputPath = join(opts.workDir, `remux.${opts.ext}`);
  const result = await runProcess({
    command: config.ffmpegPath,
    args: ["-y", "-nostdin", "-i", opts.inputPath, "-c", "copy", "-movflags", "+faststart", outputPath],
    timeoutMs: opts.timeoutMs,
    cwd: opts.workDir,
    signal: opts.signal,
  });
  if (result.code !== 0) {
    throw new AppError("PROCESSING_FAILED");
  }
  return outputPath;
}

export function probeFromFfmpegOutput(stderr: string): {
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
} {
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  let duration: number | null = null;
  if (durationMatch) {
    duration =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  }
  const videoMatch = stderr.match(
    /Stream #0:\d+.*Video:\s*([a-zA-Z0-9_]+).*?(\d{2,5})x(\d{2,5})(?:.*?(\d+(?:\.\d+)?)\s*fps)?/,
  );
  const audioMatch = stderr.match(/Stream #0:\d+.*Audio:\s*([a-zA-Z0-9_]+)/);
  const containerMatch = stderr.match(/Input #0,\s*([^,]+),/);
  return {
    duration,
    videoCodec: videoMatch?.[1] ?? null,
    width: videoMatch?.[2] ? Number(videoMatch[2]) : null,
    height: videoMatch?.[3] ? Number(videoMatch[3]) : null,
    fps: videoMatch?.[4] ? Number(videoMatch[4]) : null,
    audioCodec: audioMatch?.[1] ?? null,
    container: containerMatch?.[1]?.split(",")[0]?.trim() ?? null,
  };
}

export async function generateSampleClip(workDir: string, timeoutMs: number): Promise<string> {
  const outputPath = join(workDir, "sample.mp4");
  const result = await runProcess({
    command: config.ffmpegPath,
    args: [
      "-y",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=5:size=1280x720:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    timeoutMs,
    cwd: workDir,
  });
  if (result.code !== 0) {
    throw new AppError("PROCESSING_FAILED", `Could not generate sample clip. ${basename(outputPath)}`);
  }
  return outputPath;
}
