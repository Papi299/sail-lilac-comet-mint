import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: the deployment contract of the Product
// media workspace — the mount unit, the Worker unit's dependency on it and bind
// of it, and their agreement with the verifier's compiled-in identity.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SYSTEMD = join(REPO_ROOT, "deploy", "systemd");
const MOUNT_UNIT = join(SYSTEMD, "srv-videofetch-media.mount");
const WORKER_UNIT = join(SYSTEMD, "videofetch-worker.service");
const VERIFIER = join(REPO_ROOT, "deploy", "bin", "vf-media-workspace-verify");

const BACKING = "/var/lib/videofetch-workspace/workspace.ext4";
const MOUNT_POINT = "/srv/videofetch/media";
const WORKSPACE = `${MOUNT_POINT}/workspace`;

/** Directive lines with comments dropped and `\` continuations joined. */
function directives(source: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (pending === "" && (line === "" || line.startsWith("#") || line.startsWith(";"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    out.push(`${pending}${line}`.trim());
    pending = "";
  }
  return out;
}

function values(lines: string[], key: string): string[] {
  return lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1).trim());
}

function tokens(lines: string[], key: string): string[] {
  return values(lines, key).flatMap((v) => v.split(/\s+/).filter(Boolean));
}

/** Component-aware: `inner` is `outer` or lies beneath it. */
function isWithin(outer: string, inner: string): boolean {
  const o = outer.split("/").filter(Boolean);
  const i = inner.split("/").filter(Boolean);
  return o.length <= i.length && o.every((segment, index) => segment === i[index]);
}

describe("MAX-FILE-SIZE-4GIB: Product media workspace deployment contract", () => {
  let mount: string[];
  let mountSource: string;
  let worker: string[];
  let exec: string;
  let verifier: string;

  before(async () => {
    mountSource = await readFile(MOUNT_UNIT, "utf8");
    mount = directives(mountSource);
    worker = directives(await readFile(WORKER_UNIT, "utf8"));
    exec = values(worker, "ExecStart").join("\n");
    verifier = await readFile(VERIFIER, "utf8");
  });

  describe("srv-videofetch-media.mount", () => {
    it("mounts exactly the reviewed backing image at /srv/videofetch/media as ext4", () => {
      assert.deepEqual(values(mount, "What"), [BACKING]);
      assert.deepEqual(values(mount, "Where"), [MOUNT_POINT]);
      assert.deepEqual(values(mount, "Type"), ["ext4"]);
    });

    it("is named for its mount point, as systemd requires", () => {
      assert.equal(basename(MOUNT_UNIT), `${MOUNT_POINT.slice(1).replaceAll("/", "-")}.mount`);
    });

    it("carries exactly loop,rw,nodev,nosuid,noexec,noatime and nothing that relaxes them", () => {
      const options = values(mount, "Options");
      assert.equal(options.length, 1);
      const set = options[0]!.split(",");
      assert.deepEqual([...set].sort(), ["loop", "noatime", "nodev", "noexec", "nosuid", "rw"]);
      for (const forbidden of ["discard", "exec", "suid", "dev", "ro", "defaults", "user", "users", "owner"]) {
        assert.equal(set.includes(forbidden), false, `the workspace must never be mounted ${forbidden}`);
      }
    });

    it("fails visibly on a missing backing image instead of silently skipping", () => {
      assert.deepEqual(values(mount, "AssertPathExists"), [BACKING]);
      assert.deepEqual(values(mount, "ConditionPathExists"), [], "a Condition would skip, not fail");
    });

    it("never creates, formats, grows or trims the backing image", () => {
      for (const directive of mount) {
        assert.doesNotMatch(directive, /^Exec/, "a mount unit runs no command of its own");
        assert.doesNotMatch(directive, /mkfs|mke2fs|fallocate|truncate|resize2fs|fstrim/);
      }
      assert.equal(isWithin("/tmp", BACKING), false, "the backing image is never on ephemeral storage");
    });

    it("agrees with the verifier's compiled-in identity", () => {
      const lines = verifier.split("\n");
      assert.ok(lines.includes(`VF_BACKING_FILE=${values(mount, "What")[0]}`));
      assert.ok(lines.includes(`VF_MOUNT_POINT=${values(mount, "Where")[0]}`));
      assert.ok(lines.includes(`VF_WORKSPACE=${WORKSPACE}`));
      const required = /^VF_REQUIRED_MOUNT_OPTIONS="([^"]+)"$/m.exec(verifier)?.[1]?.split(" ") ?? [];
      assert.deepEqual(
        [...required].sort(),
        values(mount, "Options")[0]!.split(",").filter((o) => o !== "loop").sort(),
        "the verifier requires exactly the flags the unit mounts with",
      );
    });
  });

  describe("videofetch-worker.service", () => {
    it("requires, orders after and binds to the workspace mount, and depends on it by path too", () => {
      for (const key of ["Requires", "After", "BindsTo"]) {
        assert.ok(tokens(worker, key).includes("srv-videofetch-media.mount"), `${key}= must name the workspace mount`);
      }
      assert.ok(tokens(worker, "RequiresMountsFor").includes(MOUNT_POINT));
    });

    it("gates every start on the verifier with --wipe, fatally, after the old container is removed", () => {
      const pre = values(worker, "ExecStartPre");
      const removeAt = pre.findIndex((v) => v.includes("docker rm -f videofetch-worker"));
      const verifyAt = pre.findIndex((v) => v.includes("vf-media-workspace-verify"));
      assert.ok(removeAt >= 0, "the stale-container removal is still present");
      assert.ok(verifyAt > removeAt, "the wipe must run only after no Worker container can write");
      assert.equal(pre[verifyAt], "/usr/local/sbin/vf-media-workspace-verify --wipe", "no '-' prefix: failure is fatal");
      assert.equal(pre.filter((v) => v.includes("vf-media-workspace-verify")).length, 1);
    });

    it("binds the workspace at /tmp/videofetch with --mount type=bind, and never a tmpfs or -v", () => {
      const mounts = [...exec.matchAll(/--mount\s+(\S+)/g)].map((m) => m[1]);
      assert.deepEqual(mounts, [`type=bind,source=${WORKSPACE},target=/tmp/videofetch`]);
      assert.doesNotMatch(exec, /--tmpfs\b/, "the 2 GiB Product media tmpfs is retired");
      assert.doesNotMatch(exec, /(?:^|\s)(?:-v|--volume)\s+\S*:\/tmp\/videofetch\b/);
    });

    it("binds the directory the mount unit provides, not one beside it", () => {
      const source = /source=([^,\s]+)/.exec(exec)?.[1] ?? "";
      assert.ok(isWithin(values(mount, "Where")[0]!, source) && source !== MOUNT_POINT, source);
    });

    it("keeps the durable state volume and the Product workspace apart", () => {
      assert.match(exec, /--volume\s+\/var\/lib\/videofetch:\/var\/lib\/videofetch:rw\b/);
      for (const product of [WORKSPACE, BACKING]) {
        assert.equal(isWithin("/var/lib/videofetch", product), false, `${product} must not be on the state volume`);
      }
    });

    it("keeps the read-only root, dropped capabilities and no Docker socket", () => {
      assert.match(exec, /--read-only\b/);
      assert.match(exec, /--cap-drop=ALL\b/);
      assert.match(exec, /--security-opt\s+no-new-privileges\b/);
      assert.doesNotMatch(exec, /docker\.sock|--privileged\b|--cap-add/);
    });
  });
});
