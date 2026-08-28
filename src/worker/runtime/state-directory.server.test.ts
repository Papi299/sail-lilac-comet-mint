import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  prepareWorkerStateDirectory,
  WorkerStateDirectoryError,
  WORKER_DATABASE_FILENAME,
} from "./state-directory.server.ts";

/**
 * Persistent-directory safety (§10). The database file is always derived
 * internally as an exact direct child; nothing request-controlled participates.
 */

describe("Worker persistent state directory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-state-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a missing directory recursively and derives the database path", async () => {
    const target = join(root, "nested", "videofetch");

    const prepared = await prepareWorkerStateDirectory(target);

    const stats = await stat(prepared.directory);
    assert.ok(stats.isDirectory(), "directory must exist after preparation");
    assert.equal(prepared.databasePath, join(prepared.directory, WORKER_DATABASE_FILENAME));
    // Exact DIRECT child — never nested, never escaping.
    assert.equal(dirname(prepared.databasePath), prepared.directory);
  });

  it("accepts an existing directory without recreating it", async () => {
    const target = join(root, "existing");
    await mkdir(target);
    const marker = join(target, "keep.txt");
    await writeFile(marker, "preserved");

    const prepared = await prepareWorkerStateDirectory(target);

    // Nothing is deleted: preparation is never destructive.
    const markerStats = await stat(marker);
    assert.ok(markerStats.isFile(), "existing contents must survive preparation");
    assert.equal(prepared.databasePath, join(prepared.directory, WORKER_DATABASE_FILENAME));
  });

  it("requires an absolute path", async () => {
    await assert.rejects(
      () => prepareWorkerStateDirectory("relative/state"),
      (err: unknown) =>
        err instanceof WorkerStateDirectoryError && /absolute/.test(err.message),
    );
  });

  it("rejects an empty path", async () => {
    await assert.rejects(
      () => prepareWorkerStateDirectory(""),
      (err: unknown) => err instanceof WorkerStateDirectoryError,
    );
  });

  it("rejects the filesystem root", async () => {
    for (const candidate of ["/", "//", "/../"]) {
      await assert.rejects(
        () => prepareWorkerStateDirectory(candidate),
        (err: unknown) =>
          err instanceof WorkerStateDirectoryError && /root/.test(err.message),
        `${candidate} must be rejected`,
      );
    }
  });

  it("REJECTS a symlink at the state-directory leaf", async () => {
    const real = join(root, "real-target");
    await mkdir(real);
    const link = join(root, "linked-state");
    await symlink(real, link);

    await assert.rejects(
      () => prepareWorkerStateDirectory(link),
      (err: unknown) =>
        err instanceof WorkerStateDirectoryError && /symlink/.test(err.message),
    );
  });

  it("rejects a non-directory at the configured path", async () => {
    const file = join(root, "not-a-directory");
    await writeFile(file, "");

    await assert.rejects(
      () => prepareWorkerStateDirectory(file),
      (err: unknown) =>
        err instanceof WorkerStateDirectoryError && /must be a directory/.test(err.message),
    );
  });

  it("canonicalizes a parent symlink with realpath", async () => {
    const real = join(root, "real-parent");
    await mkdir(join(real, "state"), { recursive: true });
    const linkedParent = join(root, "linked-parent");
    await symlink(real, linkedParent);

    // The LEAF is a real directory; only an ancestor is a symlink, which is
    // resolved rather than rejected.
    const prepared = await prepareWorkerStateDirectory(join(linkedParent, "state"));

    assert.ok(
      !prepared.directory.includes("linked-parent"),
      `expected a canonical path, got ${prepared.directory}`,
    );
    assert.equal(dirname(prepared.databasePath), prepared.directory);
  });

  it("REJECTS a symlinked database file inside a valid directory", async () => {
    const target = join(root, "state");
    await mkdir(target);
    const elsewhere = join(root, "elsewhere.sqlite");
    await writeFile(elsewhere, "");
    await symlink(elsewhere, join(target, WORKER_DATABASE_FILENAME));

    await assert.rejects(
      () => prepareWorkerStateDirectory(target),
      (err: unknown) =>
        err instanceof WorkerStateDirectoryError && /symlink/.test(err.message),
    );
  });

  it("rejects a directory where the database name is itself a directory", async () => {
    const target = join(root, "state");
    await mkdir(join(target, WORKER_DATABASE_FILENAME), { recursive: true });

    await assert.rejects(
      () => prepareWorkerStateDirectory(target),
      (err: unknown) =>
        err instanceof WorkerStateDirectoryError && /regular file/.test(err.message),
    );
  });

  it("accepts an existing regular database file", async () => {
    const target = join(root, "state");
    await mkdir(target);
    const dbPath = join(target, WORKER_DATABASE_FILENAME);
    await writeFile(dbPath, "");

    const prepared = await prepareWorkerStateDirectory(target);
    // Compared against the CANONICAL directory: realpath legitimately rewrites
    // platform prefixes (macOS resolves /var to /private/var).
    assert.equal(prepared.databasePath, join(prepared.directory, WORKER_DATABASE_FILENAME));
    assert.ok((await stat(prepared.databasePath)).isFile());
    assert.ok(dbPath.endsWith(`/${WORKER_DATABASE_FILENAME}`));
  });

  it("never derives a database path under /tmp when the directory is elsewhere", async () => {
    // Guards the §9 contract that durable state lives on the configured
    // persistent volume, not in ephemeral temp storage.
    const target = join(root, "persistent");
    const prepared = await prepareWorkerStateDirectory(target);
    assert.equal(dirname(prepared.databasePath), prepared.directory);
    assert.ok(prepared.databasePath.endsWith(`/${WORKER_DATABASE_FILENAME}`));
  });
});
