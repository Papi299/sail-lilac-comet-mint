import { constants as FS } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";

/**
 * Persistent-state directory boundary (Phase 8A §9/§10).
 *
 * The Worker keeps exactly one durable artefact — its SQLite database and the
 * WAL/SHM sidecars SQLite derives from it. Media working files live under
 * TEMP_DIRECTORY and stay ephemeral; nothing here is ever a media path.
 *
 * The database file name is derived INTERNALLY. No request, no browser and no
 * control-plane payload can influence which file is opened: the caller supplies
 * only a directory, and the file is always an exact direct child of it.
 */

export const WORKER_DATABASE_FILENAME = "worker.sqlite";

export class WorkerStateDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerStateDirectoryError";
  }
}

export type PreparedWorkerStateDirectory = {
  /** The canonical (realpath-resolved) state directory. */
  readonly directory: string;
  /** The SQLite database file, an exact direct child of `directory`. */
  readonly databasePath: string;
};

/**
 * Validates and prepares the configured persistent state directory.
 *
 * Deliberately NOT done here, in any circumstance:
 *  - `chmod` on arbitrary parent directories;
 *  - `chown` at runtime;
 *  - following an operator-supplied symlink at the state-directory leaf;
 *  - recursive deletion of the state directory or anything inside it.
 *
 * Image build prepares the default mountpoint's ownership; a deployment-mounted
 * volume must already be writable by the non-root Worker UID.
 */
export async function prepareWorkerStateDirectory(
  configuredDirectory: string,
): Promise<PreparedWorkerStateDirectory> {
  if (typeof configuredDirectory !== "string" || configuredDirectory.length === 0) {
    throw new WorkerStateDirectoryError("state directory must be a non-empty string");
  }
  if (!isAbsolute(configuredDirectory)) {
    throw new WorkerStateDirectoryError("state directory must be an absolute path");
  }

  const normalized = normalize(configuredDirectory).replace(/\/+$/, "");
  if (normalized.length === 0 || normalized === parse(normalized).root) {
    throw new WorkerStateDirectoryError("state directory must not be the filesystem root");
  }

  // 1. Reject a symlink AT THE LEAF before anything is created or opened. A
  //    symlinked leaf would let an operator-controlled link redirect durable
  //    state off the mounted volume entirely.
  let leafStats: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    leafStats = await lstat(normalized);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new WorkerStateDirectoryError("state directory could not be inspected");
    }
  }

  if (leafStats) {
    if (leafStats.isSymbolicLink()) {
      throw new WorkerStateDirectoryError("state directory must not be a symlink");
    }
    if (!leafStats.isDirectory()) {
      throw new WorkerStateDirectoryError("state directory must be a directory");
    }
  } else {
    // 2. Create it recursively, as the runtime user, with default ownership.
    try {
      await mkdir(normalized, { recursive: true });
    } catch {
      throw new WorkerStateDirectoryError("state directory could not be created");
    }
  }

  // 3. Canonicalize. Every later path decision uses the resolved directory, so
  //    a parent symlink cannot make the derived database path ambiguous.
  let canonical: string;
  try {
    canonical = await realpath(normalized);
  } catch {
    throw new WorkerStateDirectoryError("state directory could not be resolved");
  }

  const canonicalStats = await lstat(canonical).catch(() => null);
  if (!canonicalStats || !canonicalStats.isDirectory()) {
    throw new WorkerStateDirectoryError("resolved state directory must be a directory");
  }

  // 4. Derive the database file as an EXACT direct child of the canonical
  //    directory. `dirname` equality forbids any nested or escaping path.
  const databasePath = join(canonical, WORKER_DATABASE_FILENAME);
  if (dirname(databasePath) !== canonical) {
    throw new WorkerStateDirectoryError("database path must be a direct child of the state directory");
  }

  // 5. The runtime user must be able to traverse and write the directory, so a
  //    read-only or wrongly-owned mount fails at startup rather than at the
  //    first durable write.
  try {
    await access(canonical, FS.R_OK | FS.W_OK | FS.X_OK);
  } catch {
    throw new WorkerStateDirectoryError("state directory is not writable by the runtime user");
  }

  // 6. If a database already exists it must be a regular, readable, writable
  //    file — never a symlink pointing off the volume.
  const dbStats = await lstat(databasePath).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") return null;
    throw new WorkerStateDirectoryError("database file could not be inspected");
  });

  if (dbStats) {
    if (dbStats.isSymbolicLink()) {
      throw new WorkerStateDirectoryError("database file must not be a symlink");
    }
    if (!dbStats.isFile()) {
      throw new WorkerStateDirectoryError("database path must be a regular file");
    }
    try {
      await access(databasePath, FS.R_OK | FS.W_OK);
    } catch {
      throw new WorkerStateDirectoryError("database file is not readable and writable");
    }
  }

  return Object.freeze({ directory: canonical, databasePath });
}
