import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: the deployment contract of the Product
// media workspace — the mount unit, the Worker unit's dependency on it and bind
// of it, and their agreement with the verifier's compiled-in identity.
//
// MAX-FILE-SIZE-4GIB-ROLLOUT-1B1-EXT4-PROVISIONING-RECIPE-FIX-001: the documented
// mkfs recipe must initialize ext4 metadata eagerly. Formatted with `nodiscard`
// only, a preallocated image lost allocation to post-mount inode-table
// initialization (Phase 1B, reproduced and fixed in Phase 1B0), which the
// verifier's full-allocation check rightly refuses.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SYSTEMD = join(REPO_ROOT, "deploy", "systemd");
const MOUNT_UNIT = join(SYSTEMD, "srv-videofetch-media.mount");
const WORKER_UNIT = join(SYSTEMD, "videofetch-worker.service");
const VERIFIER = join(REPO_ROOT, "deploy", "bin", "vf-media-workspace-verify");
const README = join(REPO_ROOT, "deploy", "README.md");
const RUNBOOK = join(REPO_ROOT, "docs", "architecture", "worker-deployment-runbook.md");

/** The only files that state the workspace mkfs recipe. Adding one means reviewing it here. */
const RECIPE_DOCUMENTS = [README, RUNBOOK];

/** Exactly the reviewed `-E` set, sorted. Adding an option means reviewing it here. */
const EAGER_EXTENDED_OPTIONS = ["lazy_itable_init=0", "lazy_journal_init=0", "nodiscard"];

/** mke2fs options that take a value; every other option letter is a bare flag. */
const MKFS_VALUE_OPTIONS = new Set([..."bCdeEgGiIJlLmMNoOrtTUz"]);

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

interface MkfsInvocation {
  readonly text: string;
  /** Option → value (`null` for a bare flag); a repeated option is recorded as a failure. */
  readonly options: Map<string, string | null>;
  readonly operands: string[];
  readonly repeated: string[];
}

/** Shell line continuations joined, so wrapping never changes what a command says. */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n[ \t]*/g, " ");
}

function isMkfsAt(argv: string[], index: number): boolean {
  const word = argv[index];
  return word === "mkfs.ext4" || word === "mke2fs" || (word === "mkfs" && (argv[index + 1] ?? "").startsWith("-t"));
}

function parseMkfs(argv: string[]): MkfsInvocation {
  const options = new Map<string, string | null>();
  const operands: string[] = [];
  const repeated: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!/^-[A-Za-z]/.test(token)) {
      operands.push(token);
      continue;
    }
    const flag = token.slice(0, 2);
    const takesValue = MKFS_VALUE_OPTIONS.has(flag[1]!);
    const value = takesValue ? (token.length > 2 ? token.slice(2) : (argv[++i] ?? "")) : null;
    const key = takesValue ? flag : token;
    if (options.has(key)) repeated.push(key);
    options.set(key, value);
  }
  return { text: argv.join(" "), options, operands, repeated };
}

/**
 * Every mkfs invocation written as code in a Markdown document: fenced lines
 * (comments dropped, continuations joined) and inline code spans.
 */
function mkfsInvocations(markdown: string): MkfsInvocation[] {
  const found: MkfsInvocation[] = [];
  const collect = (code: string) => {
    const argv = code.split(/\s+/).filter(Boolean);
    const at = argv.findIndex((_, index) => isMkfsAt(argv, index));
    if (at >= 0) found.push(parseMkfs(argv.slice(at)));
  };
  let fenced = false;
  for (const raw of joinContinuations(markdown).split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) collect(line.replace(/(^|\s)#.*$/, ""));
    else for (const span of line.matchAll(/`([^`]+)`/g)) collect(span[1]!);
  }
  return found;
}

/** Textual mentions that carry options — prose naming the tool alone is not a command. */
function mkfsCommandMentions(text: string): number {
  return [...joinContinuations(text).matchAll(/\b(?:mkfs\.ext4|mke2fs)[ \t]+-|\bmkfs[ \t]+-t/g)].length;
}

/** Every `-E` list anywhere in the text that names a discard or lazy-init ext4 option. */
function ext4ExtendedOptionLists(text: string): string[] {
  return [...joinContinuations(text).matchAll(/(?:^|[\s`(])-E[ \t]*([\w=,]+)/gm)]
    .map((match) => match[1]!)
    .filter((list) => /discard|lazy_/.test(list));
}

function sortedExtendedOptions(list: string | null | undefined): string[] {
  return (list ?? "").split(",").filter(Boolean).sort();
}

async function filesBeneath(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBeneath(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
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

  describe("backing-image filesystem recipe (eager ext4 initialization)", () => {
    const documents = new Map<string, string>();

    before(async () => {
      for (const path of RECIPE_DOCUMENTS) documents.set(path, await readFile(path, "utf8"));
    });

    it("deploy/README.md formats the reviewed backing image with exactly the eager-initialization recipe", () => {
      const commands = mkfsInvocations(documents.get(README)!);
      assert.equal(commands.length, 1, "exactly one provisioning mkfs command");
      const [command] = commands;
      assert.deepEqual(command!.repeated, [], command!.text);
      assert.deepEqual(
        [...command!.options.keys()].sort(),
        ["-E", "-L", "-T", "-m"],
        `no option beyond -m, -T, -E and -L without review: ${command!.text}`,
      );
      assert.equal(command!.options.get("-m"), "0");
      assert.equal(command!.options.get("-T"), "largefile");
      assert.equal(command!.options.get("-L"), "vf-media");
      assert.deepEqual(sortedExtendedOptions(command!.options.get("-E")), EAGER_EXTENDED_OPTIONS, command!.text);
      assert.deepEqual(command!.operands, [BACKING], "it formats only the reviewed backing image");
    });

    it("the runbook's workspace contract states the same recipe", () => {
      const commands = mkfsInvocations(documents.get(RUNBOOK)!);
      assert.ok(commands.length >= 1, "the runbook states the recipe");
      for (const command of commands) {
        assert.deepEqual(command.repeated, [], command.text);
        assert.equal(command.options.get("-m"), "0", command.text);
        assert.equal(command.options.get("-T"), "largefile", command.text);
        assert.deepEqual(sortedExtendedOptions(command.options.get("-E")), EAGER_EXTENDED_OPTIONS, command.text);
        for (const key of command.options.keys()) {
          assert.ok(["-E", "-L", "-T", "-m"].includes(key), `unreviewed option ${key}: ${command.text}`);
        }
        if (command.options.has("-L")) assert.equal(command.options.get("-L"), "vf-media", command.text);
        assert.ok(
          command.operands.length === 0 || (command.operands.length === 1 && command.operands[0] === BACKING),
          command.text,
        );
      }
    });

    it("parses every mkfs command the recipe documents write, including ones in comments or prose", () => {
      for (const [path, text] of documents) {
        assert.equal(
          mkfsCommandMentions(text),
          mkfsInvocations(text).length,
          `${relative(REPO_ROOT, path)}: an mkfs command outside a code span or fenced command line is unchecked`,
        );
      }
    });

    it("never documents a discard or lazy-init -E list other than the reviewed eager set, such as bare -E nodiscard", () => {
      for (const [path, text] of documents) {
        const lists = ext4ExtendedOptionLists(text);
        assert.ok(lists.length >= 1, `${relative(REPO_ROOT, path)} states the -E list`);
        for (const list of lists) {
          assert.deepEqual(sortedExtendedOptions(list), EAGER_EXTENDED_OPTIONS, `${relative(REPO_ROOT, path)}: -E ${list}`);
        }
      }
    });

    it("states the recipe only in the reviewed documents under deploy/ and docs/", async () => {
      const stating: string[] = [];
      for (const directory of [join(REPO_ROOT, "deploy"), join(REPO_ROOT, "docs")]) {
        for (const path of await filesBeneath(directory)) {
          const text = await readFile(path, "utf8");
          if (mkfsCommandMentions(text) > 0 || ext4ExtendedOptionLists(text).length > 0) stating.push(path);
        }
      }
      assert.deepEqual(
        stating.map((path) => relative(REPO_ROOT, path)).sort(),
        RECIPE_DOCUMENTS.map((path) => relative(REPO_ROOT, path)).sort(),
      );
    });
  });
});
