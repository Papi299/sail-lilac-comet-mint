import { stat, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { AppError } from "@/lib/errors";
import { config } from "@/lib/config";

export async function validateLocalOutput(
  workDir: string,
  filePath: string
): Promise<{ size: number }> {
  // filePath must not look like a URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(filePath) || filePath.startsWith("//")) {
    throw new AppError("PROCESSING_FAILED", "Invalid local path shape");
  }

  const canonicalWorkDir = resolve(workDir);
  const canonicalFile = resolve(filePath);

  // must remain exactly inside workDir
  if (!canonicalFile.startsWith(canonicalWorkDir + "/") && canonicalFile !== canonicalWorkDir) {
    throw new AppError("PROCESSING_FAILED", "Output file escaped workDir");
  }

  try {
    const linkStat = await lstat(canonicalFile);
    if (linkStat.isSymbolicLink()) {
      throw new AppError("PROCESSING_FAILED", "Output is a symlink");
    }

    const fileStat = await stat(canonicalFile);
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

    return { size: fileStat.size };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError("PROCESSING_FAILED", "Output file inaccessible");
  }
}
