import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobId } from "../jobs/store.server.ts";
import {
  assertRemovableJobDir,
  createJobDir,
  jobsRoot,
  removeJobDir,
  setTempDirectoryForTests,
  tempRoot,
  UnsafePathError,
} from "./files.server.ts";

async function withTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "videofetch-files-"));
  setTempDirectoryForTests(dir);
  return dir;
}

describe("job directory containment", () => {
  afterEach(() => {
    setTempDirectoryForTests(null);
  });

  it("treats a generated job directory as removable and deletes only that directory", async () => {
    await withTempRoot();
    const id = createJobId();
    const dir = await createJobDir(id);
    await writeFile(join(dir, "clip.mp4"), "x");
    // createJobDir returns the canonical path; removeJobDir accepts it.
    await removeJobDir(dir);
    await assert.rejects(() => stat(dir), { code: "ENOENT" });
    // Verify the canonical jobs root and temp root still exist.
    const canonicalJobs = await realpath(jobsRoot());
    const root = await stat(canonicalJobs);
    assert.equal(root.isDirectory(), true);
    const canonicalTemp = await realpath(tempRoot());
    const temp = await stat(canonicalTemp);
    assert.equal(temp.isDirectory(), true);
  });

  it("rejects /tmp, /, the temp root, and the jobs root", async () => {
    const root = await withTempRoot();
    assert.throws(() => assertRemovableJobDir("/tmp"), UnsafePathError);
    assert.throws(() => assertRemovableJobDir("/"), UnsafePathError);
    assert.throws(() => assertRemovableJobDir(root), UnsafePathError);
    assert.throws(() => assertRemovableJobDir(jobsRoot()), UnsafePathError);
    await assert.rejects(() => removeJobDir("/tmp"), UnsafePathError);
    await assert.rejects(() => removeJobDir("/"), UnsafePathError);
    const tmpStat = await stat("/tmp");
    assert.equal(tmpStat.isDirectory(), true);
  });

  it("rejects empty paths, siblings, and traversal outside the jobs root", async () => {
    const root = await withTempRoot();
    const id = createJobId();
    await createJobDir(id);
    assert.throws(() => assertRemovableJobDir(""), UnsafePathError);
    assert.throws(() => assertRemovableJobDir("   "), UnsafePathError);
    assert.throws(() => assertRemovableJobDir(join(root, "jobs-evil", id)), UnsafePathError);
    assert.throws(() => assertRemovableJobDir(join(jobsRoot(), "..", "sibling")), UnsafePathError);
    assert.throws(
      () => assertRemovableJobDir(join(jobsRoot(), id, "..", "..", "..", "etc")),
      UnsafePathError,
    );
    assert.throws(() => assertRemovableJobDir(join(jobsRoot(), "not-a-job-id")), UnsafePathError);
  });

  it("refuses to delete a job path that is a symlink to an outside directory", async () => {
    await withTempRoot();
    const outside = await mkdtemp(join(tmpdir(), "videofetch-outside-"));
    const canary = join(outside, "keep-me");
    await writeFile(canary, "safe");
    const id = createJobId();
    await mkdir(jobsRoot(), { recursive: true });
    const link = join(jobsRoot(), id);
    await symlink(outside, link);
    await assert.rejects(() => removeJobDir(link), UnsafePathError);
    const still = await stat(canary);
    assert.equal(still.isFile(), true);
  });

  it("rejects createJobDir when the jobs root is a symlink to an outside directory", async () => {
    await withTempRoot();
    const outside = await mkdtemp(join(tmpdir(), "videofetch-jobs-outside-"));
    const canary = join(outside, "keep-me");
    await writeFile(canary, "safe");
    await symlink(outside, jobsRoot());
    const id = createJobId();
    await assert.rejects(() => createJobDir(id), UnsafePathError);
    await assert.rejects(() => stat(join(outside, id)), { code: "ENOENT" });
    const names = await readdir(outside);
    assert.equal(names.includes(id), false);
    const still = await stat(canary);
    assert.equal(still.isFile(), true);
  });

  it("rejects removeJobDir when the jobs root is a symlink to an outside directory", async () => {
    await withTempRoot();
    const outside = await mkdtemp(join(tmpdir(), "videofetch-jobs-rm-outside-"));
    const canary = join(outside, "keep-me");
    await writeFile(canary, "safe");
    const id = createJobId();
    await mkdir(join(outside, id));
    await writeFile(join(outside, id, "clip.mp4"), "secret");
    await symlink(outside, jobsRoot());
    await assert.rejects(() => removeJobDir(join(jobsRoot(), id)), UnsafePathError);
    const still = await stat(canary);
    assert.equal(still.isFile(), true);
    const leftover = await stat(join(outside, id, "clip.mp4"));
    assert.equal(leftover.isFile(), true);
  });

  it("rejects a temp root that is a symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "videofetch-temp-parent-"));
    const outside = await mkdtemp(join(tmpdir(), "videofetch-temp-outside-"));
    const canary = join(outside, "keep-me");
    await writeFile(canary, "safe");
    const tempLink = join(parent, "temp");
    await symlink(outside, tempLink);
    setTempDirectoryForTests(tempLink);
    const id = createJobId();
    await assert.rejects(() => createJobDir(id), UnsafePathError);
    await assert.rejects(() => stat(join(outside, "jobs", id)), { code: "ENOENT" });
    const still = await stat(canary);
    assert.equal(still.isFile(), true);
  });

  it("accepts a temp root reached through a symlinked ancestor directory", async () => {
    // Construct: realRoot/temp (real dir), then aliasParent -> realRoot
    // so aliasParent/temp resolves through a symlinked ancestor.
    const base = await mkdtemp(join(tmpdir(), "videofetch-ancestor-"));
    const realRoot = join(base, "real-root");
    const tempDir = join(realRoot, "temp");
    await mkdir(tempDir, { recursive: true });

    const aliasParent = join(base, "alias-parent");
    await symlink(realRoot, aliasParent);

    // Configure temp root through the alias.
    const aliasTemp = join(aliasParent, "temp");
    setTempDirectoryForTests(aliasTemp);

    const id = createJobId();
    // createJobDir must succeed even though the ancestor is a symlink.
    const dir = await createJobDir(id);

    // Returned path must be beneath the canonical jobs root.
    // Note: canonicalize tempDir too, since tmpdir() itself may have
    // symlinked ancestors (e.g. macOS /var -> /private/var).
    const canonicalTemp = await realpath(aliasTemp);
    const expectedCanonicalTemp = await realpath(tempDir);
    assert.equal(canonicalTemp, expectedCanonicalTemp, "canonical temp should resolve to real dir");
    const canonicalJobs = join(canonicalTemp, "jobs");
    assert.equal(dir, join(canonicalJobs, id));

    // Write a file and verify removal works.
    await writeFile(join(dir, "clip.mp4"), "x");
    await removeJobDir(dir);
    await assert.rejects(() => stat(dir), { code: "ENOENT" });

    // The canonical jobs root and temp root still exist.
    const jobsStat = await stat(canonicalJobs);
    assert.equal(jobsStat.isDirectory(), true);
    const tempStat = await stat(canonicalTemp);
    assert.equal(tempStat.isDirectory(), true);
  });
});
