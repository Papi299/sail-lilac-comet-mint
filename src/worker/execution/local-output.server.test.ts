import test from "node:test";
import assert from "node:assert";
import { createReadStream } from "node:fs";
import { validateLocalOutput } from "./local-output.server.ts";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { join } from "node:path";
import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  mkdir,
  realpath,
  truncate,
  open,
} from "node:fs/promises";
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

test("local-output containment completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-output-containment-"));
  const workDir = join(root, "work");
  const outside = join(root, "outside");
  await mkdir(workDir);
  await mkdir(outside);

  await t.test("§25: rejects a file reached through a PARENT-directory symlink", async () => {
    // The leaf is a perfectly ordinary regular file — only one of its ancestor
    // directories is a symlink pointing out of the job directory. A leaf-only
    // lstat check would accept this; canonicalization must not.
    const escapeTarget = join(outside, "escaped.mp4");
    await writeFile(escapeTarget, "escaped-bytes");

    const parentLink = join(workDir, "sub");
    await symlink(outside, parentLink);

    const throughParent = join(parentLink, "escaped.mp4");
    await assert.rejects(
      validateLocalOutput(workDir, throughParent),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "PROCESSING_FAILED");
        assert.match(err.message, /escaped workDir/);
        return true;
      },
    );

    await rm(parentLink, { force: true });
  });

  await t.test("§25: rejects a nested parent-symlink chain", async () => {
    const deep = join(workDir, "a");
    await mkdir(deep, { recursive: true });
    const chainLink = join(deep, "b");
    await symlink(outside, chainLink);
    await writeFile(join(outside, "deep.mp4"), "deep-bytes");

    await assert.rejects(
      validateLocalOutput(workDir, join(chainLink, "deep.mp4")),
      /escaped workDir/,
    );

    await rm(deep, { recursive: true, force: true });
  });

  await t.test("§25: rejects protocol-relative and scheme-prefixed paths", async () => {
    for (const candidate of [
      "//cdn.example.com/video.mp4",
      "//localhost/share/video.mp4",
      "https://cdn.example.com/video.mp4",
      "file:///etc/passwd",
      "data:video/mp4;base64,AAAA",
    ]) {
      await assert.rejects(
        validateLocalOutput(workDir, candidate),
        (err: unknown) => {
          assert.ok(err instanceof AppError, `${candidate}: expected AppError`);
          assert.strictEqual(err.code, "PROCESSING_FAILED", candidate);
          assert.match(err.message, /Invalid local path shape/, candidate);
          return true;
        },
        candidate,
      );
    }
  });

  await t.test("§25: an oversized artifact is TOO_LARGE", async () => {
    const huge = join(workDir, "huge.mp4");
    const handle = await open(huge, "w");
    await handle.close();
    // Sparse allocation: no bytes are written, but stat() reports the size.
    await truncate(huge, config.maxFileSize + 1);

    await assert.rejects(
      validateLocalOutput(workDir, huge),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "TOO_LARGE");
        return true;
      },
    );

    await rm(huge, { force: true });
  });

  await t.test("§25: a file exactly at the size limit is accepted", async () => {
    const atLimit = join(workDir, "at-limit.mp4");
    const handle = await open(atLimit, "w");
    await handle.close();
    await truncate(atLimit, config.maxFileSize);

    const res = await validateLocalOutput(workDir, atLimit);
    assert.strictEqual(res.size, config.maxFileSize);

    await rm(atLimit, { force: true });
  });

  await t.test("§25: the returned path is canonical and is the exact path opened", async () => {
    const payload = "canonical-stream-payload";
    const target = join(workDir, "canonical.mp4");
    await writeFile(target, payload);

    // Reach the very same file through a non-canonical spelling.
    const nonCanonical = `${workDir}/./canonical.mp4`;
    const res = await validateLocalOutput(workDir, nonCanonical);

    const canonical = await realpath(target);
    assert.strictEqual(res.path, canonical, "the returned path is fully canonicalized");
    assert.notStrictEqual(res.path, nonCanonical, "the caller's spelling was not passed through");
    assert.strictEqual(res.size, payload.length);

    // The canonical path is what an upload stream actually reads.
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(res.path)) {
      chunks.push(Buffer.from(chunk));
    }
    assert.strictEqual(Buffer.concat(chunks).toString("utf8"), payload);

    await rm(target, { force: true });
  });

  await t.test("§25: a symlinked workDir still yields a canonical contained path", async () => {
    const realWork = join(root, "real-work");
    await mkdir(realWork);
    const linkedWork = join(root, "linked-work");
    await symlink(realWork, linkedWork);

    const file = join(realWork, "inside.mp4");
    await writeFile(file, "inside");

    const res = await validateLocalOutput(linkedWork, join(linkedWork, "inside.mp4"));
    assert.strictEqual(res.path, await realpath(file));
    assert.strictEqual(res.size, 6);
  });

  await t.test("§25: a missing artifact is rejected, not silently accepted", async () => {
    await assert.rejects(
      validateLocalOutput(workDir, join(workDir, "never-created.mp4")),
      /inaccessible/,
    );
  });

  await rm(root, { recursive: true, force: true });
});
