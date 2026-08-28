import test from "node:test";
import assert from "node:assert";
import { validateLocalOutput } from "./local-output.server.ts";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

test("local-output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "local-output-test-"));
  const validFile = join(dir, "out.mp4");
  await writeFile(validFile, "data");

  await t.test("accepts valid file", async () => {
    const res = await validateLocalOutput(dir, validFile);
    assert.strictEqual(res.size, 4);
  });

  await t.test("rejects outside file", async () => {
    await assert.rejects(validateLocalOutput(dir, join(dir, "../foo.mp4")), /escaped workDir/);
  });

  await t.test("rejects symlink", async () => {
    const link = join(dir, "link.mp4");
    await symlink(validFile, link);
    await assert.rejects(validateLocalOutput(dir, link), /symlink/);
  });

  await t.test("rejects directory", async () => {
    const inner = join(dir, "inner");
    await mkdir(inner);
    await assert.rejects(validateLocalOutput(dir, inner), /regular file/);
  });

  await t.test("rejects URL shape", async () => {
    await assert.rejects(validateLocalOutput(dir, "http://foo"), /invalid local path/i);
  });

  await t.test("rejects empty file", async () => {
    const empty = join(dir, "empty.mp4");
    await writeFile(empty, "");
    await assert.rejects(validateLocalOutput(dir, empty), /empty/);
  });

  await rm(dir, { recursive: true, force: true });
});
