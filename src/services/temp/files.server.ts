import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "@/lib/config";

let initialized = false;

export async function ensureTempRoot(): Promise<string> {
  if (!initialized) {
    await mkdir(config.tempDirectory, { recursive: true });
    initialized = true;
  }
  return config.tempDirectory;
}

export async function createJobDir(jobId: string): Promise<string> {
  const root = await ensureTempRoot();
  const dir = join(root, "jobs", jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeJobDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
}

export async function tempUsage(): Promise<{ bytes: number; files: number }> {
  const root = await ensureTempRoot();
  return walkSize(root);
}

async function walkSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await walkSize(path);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      try {
        const st = await stat(path);
        bytes += st.size;
        files += 1;
      } catch {
        // ignore racing deletes
      }
    }
  }
  return { bytes, files };
}
