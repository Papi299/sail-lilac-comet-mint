import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "@/lib/config";

export const JOB_ID_RE = /^[0-9a-f]{32}$/;

export class UnsafePathError extends Error {
  constructor(message = "Refusing to delete a path outside the job directory root.") {
    super(message);
    this.name = "UnsafePathError";
  }
}

let rootOverride: string | null = null;

export function setTempDirectoryForTests(dir: string | null): void {
  rootOverride = dir;
}

export function tempRoot(): string {
  return resolve(rootOverride ?? config.tempDirectory);
}

export function jobsRoot(): string {
  return resolve(join(tempRoot(), "jobs"));
}

export function isJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

export async function ensureTempRoot(): Promise<string> {
  const root = tempRoot();
  await mkdir(root, { recursive: true });
  return root;
}

export async function createJobDir(jobId: string): Promise<string> {
  if (!isJobId(jobId)) {
    throw new UnsafePathError("Refusing to create a job directory without a valid job id.");
  }
  await ensureTempRoot();
  const dir = resolve(join(jobsRoot(), jobId));
  assertRemovableJobDir(dir);
  await mkdir(dir, { recursive: true });
  const canonical = await realpath(dir);
  const rootCanonical = await realpath(jobsRoot());
  if (dirname(canonical) !== rootCanonical || basename(canonical) !== jobId) {
    throw new UnsafePathError();
  }
  return canonical;
}

/**
 * Canonical path that may be recursively deleted: exactly
 * `<TEMP_DIRECTORY>/jobs/<32-hex-job-id>`.
 */
export function assertRemovableJobDir(workDir: string): string {
  if (!workDir || !workDir.trim()) {
    throw new UnsafePathError("Empty path.");
  }

  const root = jobsRoot();
  const target = resolve(workDir);
  const temp = tempRoot();

  if (target === sep || target === resolve("/") || target === resolve("/tmp") || target === temp || target === root) {
    throw new UnsafePathError();
  }

  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafePathError();
  }

  if (dirname(target) !== root) {
    throw new UnsafePathError();
  }

  const leaf = basename(target);
  if (!isJobId(leaf)) {
    throw new UnsafePathError();
  }

  if (join(root, leaf) !== target) {
    throw new UnsafePathError();
  }

  return target;
}

export async function removeJobDir(workDir: string): Promise<void> {
  const target = assertRemovableJobDir(workDir);
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }

  let rootCanonical: string;
  try {
    rootCanonical = await realpath(jobsRoot());
  } catch {
    throw new UnsafePathError();
  }

  if (dirname(canonical) !== rootCanonical || basename(canonical) !== basename(target)) {
    throw new UnsafePathError();
  }

  await rm(canonical, { recursive: true, force: true });
}

export async function tempUsage(): Promise<{ bytes: number; files: number }> {
  await ensureTempRoot();
  return walkSize(tempRoot());
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
