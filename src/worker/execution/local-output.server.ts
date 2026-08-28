import { stat, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { AppError } from "@/lib/errors";
import { config } from "@/lib/config";

export async function validateLocalOutput(
  workDir: string,
  filePath: string
): Promise<{ path: string, size: number }> {
  // filePath must not look like a URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(filePath) || filePath.startsWith("//")) {
    throw new AppError("PROCESSING_FAILED", "Invalid local path shape");
  }

  let canonicalWorkDir: string;
  try {
    canonicalWorkDir = await realpath(workDir);
  } catch {
    throw new AppError("PROCESSING_FAILED", "Output file inaccessible");
  }

  const resolvedFile = resolve(filePath);
  const resolvedWorkDir = resolve(workDir);
  if (!resolvedFile.startsWith(resolvedWorkDir + "/") && resolvedFile !== resolvedWorkDir) {
    throw new AppError("PROCESSING_FAILED", "Output file escaped workDir");
  }

  let fileStat;
  try {
    const linkStat = await lstat(resolvedFile);
    if (linkStat.isSymbolicLink()) {
      throw new AppError("PROCESSING_FAILED", "Output is a symlink");
    }

    const finalPath = await realpath(resolvedFile);
    if (dirname(finalPath) !== canonicalWorkDir) {
      throw new AppError("PROCESSING_FAILED", "Output file escaped workDir");
    }

    fileStat = await stat(finalPath);
    if (!fileStat.isFile()) {
      throw new AppError("PROCESSING_FAILED", "Output is not a regular file");
    }

    if (!Number.isSafeInteger(fileStat.size)) {
      throw new AppError("PROCESSING_FAILED", "Output size is not a safe integer");
    }

    if (fileStat.size <= 0) {
      throw new AppError("PROCESSING_FAILED", "Output file is empty");
    }

    if (fileStat.size > config.maxFileSize) {
      throw new AppError("TOO_LARGE");
    }

    return { path: finalPath, size: fileStat.size };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError("PROCESSING_FAILED", "Output file inaccessible");
  }
}
