import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
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
    assert.equal(assertRemovableJobDir(dir), dir);
    await removeJobDir(dir);
    await assert.rejects(() => stat(dir), { code: "ENOENT" });
    const root = await stat(jobsRoot());
    assert.equal(root.isDirectory(), true);
    const temp = await stat(tempRoot());
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
});
