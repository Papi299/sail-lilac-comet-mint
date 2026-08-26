import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
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

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function assertNotSentinel(path: string): void {
  if (path === sep || path === resolve("/") || path === resolve("/tmp")) {
    throw new UnsafePathError();
  }
}

/**
 * Temp root and jobs root are trust boundaries: real directories (the
 * configured entry itself must not be a symlink), with the canonical
 * layout `<temp>/jobs`.
 *
 * Ancestor symlinks (e.g. macOS `/var -> /private/var`) are permitted
 * because they are system-controlled and do not violate containment.
 * Only the final path component of each trust boundary is verified via
 * `lstat` to ensure it is not itself a symlink.
 */
export async function assertTrustedJobRoots(): Promise<{ temp: string; jobs: string }> {
  const tempLogical = tempRoot();
  const jobsLogical = jobsRoot();
  assertNotSentinel(tempLogical);
  assertNotSentinel(jobsLogical);

  // The configured temp root entry itself must be a real directory.
  const tempSt = await lstatIfExists(tempLogical);
  if (!tempSt || tempSt.isSymbolicLink() || !tempSt.isDirectory()) {
    throw new UnsafePathError();
  }
  // Establish canonical trusted temp root (may differ from logical if
  // an ancestor directory is a symlink, e.g. /var -> /private/var).
  const tempCanonical = await realpath(tempLogical);

  // The jobs entry itself must be a real directory.
  const jobsSt = await lstatIfExists(jobsLogical);
  if (!jobsSt || jobsSt.isSymbolicLink() || !jobsSt.isDirectory()) {
    throw new UnsafePathError();
  }
  // Establish canonical trusted jobs root.
  const jobsCanonical = await realpath(jobsLogical);

  // Canonical layout: jobs is exactly `<tempCanonical>/jobs`.
  if (dirname(jobsCanonical) !== tempCanonical || basename(jobsCanonical) !== "jobs") {
    throw new UnsafePathError();
  }
  return { temp: tempCanonical, jobs: jobsCanonical };
}

export async function ensureTempRoot(): Promise<string> {
  const root = tempRoot();
  const existing = await lstatIfExists(root);
  if (existing?.isSymbolicLink()) {
    throw new UnsafePathError();
  }
  if (!existing) {
    await mkdir(root, { recursive: true });
  }
  const after = await lstat(root);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new UnsafePathError();
  }
  return root;
}

async function ensureJobsRoot(): Promise<string> {
  await ensureTempRoot();
  const jobs = jobsRoot();
  const existing = await lstatIfExists(jobs);
  if (existing?.isSymbolicLink()) {
    throw new UnsafePathError();
  }
  if (!existing) {
    try {
      await mkdir(jobs, { recursive: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new UnsafePathError();
      }
    }
  }
  const after = await lstat(jobs);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new UnsafePathError();
  }
  const trusted = await assertTrustedJobRoots();
  return trusted.jobs;
}

export async function createJobDir(jobId: string): Promise<string> {
  if (!isJobId(jobId)) {
    throw new UnsafePathError("Refusing to create a job directory without a valid job id.");
  }
  // ensureJobsRoot returns the canonical jobs root.
  const jobsCanonical = await ensureJobsRoot();
  const dir = resolve(join(jobsCanonical, jobId));
  assertRemovableJobDirCanonical(dir, jobsCanonical);
  const existing = await lstatIfExists(dir);
  if (existing?.isSymbolicLink()) {
    throw new UnsafePathError();
  }
  if (!existing) {
    await mkdir(dir, { recursive: false });
  }
  const leaf = await lstat(dir);
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) {
    throw new UnsafePathError();
  }
  const canonical = await realpath(dir);
  if (dirname(canonical) !== jobsCanonical || basename(canonical) !== jobId || canonical !== dir) {
    throw new UnsafePathError();
  }
  return canonical;
}

/**
 * Synchronous syntactic validation that a path is exactly
 * `<canonicalJobsRoot>/<32-hex-job-id>`.
 */
function assertRemovableJobDirCanonical(workDir: string, canonicalJobsRoot: string): string {
  if (!workDir || !workDir.trim()) {
    throw new UnsafePathError("Empty path.");
  }

  const target = resolve(workDir);
  const temp = dirname(canonicalJobsRoot);

  if (target === sep || target === resolve("/") || target === resolve("/tmp") || target === temp || target === canonicalJobsRoot) {
    throw new UnsafePathError();
  }

  const rel = relative(canonicalJobsRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafePathError();
  }

  if (dirname(target) !== canonicalJobsRoot) {
    throw new UnsafePathError();
  }

  const leaf = basename(target);
  if (!isJobId(leaf)) {
    throw new UnsafePathError();
  }

  if (join(canonicalJobsRoot, leaf) !== target) {
    throw new UnsafePathError();
  }

  return target;
}

/**
 * Public synchronous guard: validates against the LOGICAL jobs root.
 * For paths that were already canonicalized (returned by createJobDir),
 * callers should use the canonical overload or removeJobDir directly.
 *
 * Retained for backward compatibility with existing tests that pass
 * logical paths.
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
  // Establish canonical trust roots first.
  const { jobs: jobsCanonical } = await assertTrustedJobRoots();
  // Validate against canonical root.
  const target = assertRemovableJobDirCanonical(workDir, jobsCanonical);
  const leaf = await lstatIfExists(target);
  if (!leaf) return;
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) {
    throw new UnsafePathError();
  }
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  if (dirname(canonical) !== jobsCanonical || basename(canonical) !== basename(target) || canonical !== target) {
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
