import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: `deploy/bin/vf-media-workspace-verify`.
//
// No root, no loop device and no real mount is needed. The script is SOURCED
// (which does not run it) and its read-only probe functions — the only commands
// that inspect the system — are replaced with recorded fixtures. Every probe and
// the destructive wipe append to an event log, so ordering is asserted, not
// assumed. The real wipe command is exercised separately on a temp directory.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "deploy", "bin", "vf-media-workspace-verify");

const BACKING = "/var/lib/videofetch-workspace/workspace.ext4";
const MOUNT_POINT = "/srv/videofetch/media";
const WORKSPACE = "/srv/videofetch/media/workspace";
const GOOD_OPTIONS = "rw,nosuid,nodev,noexec,noatime";

/** A correct, provisioned Production workspace, as the probes would report it. */
const GOOD = {
  FX_EUID: "0",
  // type|uid|gid|mode|size|blocks|block-unit: 20,971,520 x 512 = exactly 10 GiB.
  FX_FILE: "regular file|0|0|600|10737418240|20971520|512",
  FX_MOUNT: `/dev/loop0 ext4 ${GOOD_OPTIONS}`,
  FX_LOOP: BACKING,
  FX_WORKSPACE: "directory|1000|1000|700|2049",
  FX_WORKSPACE_AFTER_WIPE: "",
  FX_ROOT: "directory|0|0|755|2049",
  // block-size|total-blocks|available-blocks, before and after the wipe.
  FX_CAPACITY: "4096|2621440|2600000",
  FX_CAPACITY_AFTER_WIPE: "4096|2621440|2621000",
  FX_LISTING_AFTER_WIPE: "",
  FX_WIPE_EXIT: "0",
};

type Fixture = Partial<Record<keyof typeof GOOD, string>>;

const HARNESS = `
set -euo pipefail
source "$VF_SCRIPT"
vf_event() { printf '%s\\n' "$1" >> "$FX_EVENTS"; }
vf_wiped() { grep -qx 'wipe' "$FX_EVENTS"; }
vf_emit() { [ "$1" = "__FAIL__" ] && return 1; printf '%s\\n' "$1"; }
vf_probe_euid() { vf_event euid; vf_emit "$FX_EUID"; }
vf_probe_file_stat() { vf_event "file:$1"; vf_emit "$FX_FILE"; }
vf_probe_dir_stat() {
  vf_event "dir:$1"
  if [ "$1" = "$VF_MOUNT_POINT" ]; then vf_emit "$FX_ROOT"
  elif vf_wiped && [ -n "$FX_WORKSPACE_AFTER_WIPE" ]; then vf_emit "$FX_WORKSPACE_AFTER_WIPE"
  else vf_emit "$FX_WORKSPACE"; fi
}
vf_probe_mount() { vf_event "mount:$1"; vf_emit "$FX_MOUNT"; }
vf_probe_loop_backing() { vf_event "loop:$1"; vf_emit "$FX_LOOP"; }
vf_probe_fs_capacity() {
  vf_event "capacity:$1"
  if vf_wiped; then vf_emit "$FX_CAPACITY_AFTER_WIPE"; else vf_emit "$FX_CAPACITY"; fi
}
vf_list_workspace() {
  vf_event "list:$1"
  if vf_wiped; then printf '%s' "$FX_LISTING_AFTER_WIPE"; else printf 'stale-job\\n'; fi
}
vf_wipe_workspace() { vf_event wipe; vf_event "wipe-target:$1"; return "$FX_WIPE_EXIT"; }
vf_main "$@"
`;

let scratch = "";
let runs = 0;

async function runVerifier(fixture: Fixture, args: string[] = []) {
  const events = join(scratch, `events-${runs++}`);
  await writeFile(events, "");
  const result = spawnSync("bash", ["-c", HARNESS, "vf-media-workspace-verify", ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VF_SCRIPT: SCRIPT, FX_EVENTS: events, ...GOOD, ...fixture },
    encoding: "utf8",
  });
  const log = (await readFile(events, "utf8")).split("\n").filter((line) => line.length > 0);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, events: log };
}

const withOptions = (options: string): Fixture => ({ FX_MOUNT: `/dev/loop0 ext4 ${options}` });
const withFile = (fields: string): Fixture => ({ FX_FILE: fields });

/** Every refusal must stop the start AND leave the workspace untouched. */
const REFUSALS: ReadonlyArray<readonly [string, Fixture, RegExp]> = [
  ["a non-root caller", { FX_EUID: "1000" }, /must run as root/],
  ["an absent backing image", { FX_FILE: "__FAIL__" }, /cannot be inspected/],
  ["a backing image that is a directory", withFile("directory|0|0|600|10737418240|20971520|512"), /not a regular file/],
  ["a backing image that is a symlink", withFile("symbolic link|0|0|777|44|0|512"), /not a regular file/],
  ["a backing image not owned by root", withFile("regular file|1000|0|600|10737418240|20971520|512"), /not owned root:root \(1000:0\)/],
  ["a backing image whose group is not root", withFile("regular file|0|1000|600|10737418240|20971520|512"), /not owned root:root \(0:1000\)/],
  ["a backing image with mode 0644", withFile("regular file|0|0|644|10737418240|20971520|512"), /mode 644 is not 600/],
  ["a backing image one byte short of 10 GiB", withFile("regular file|0|0|600|10737418239|20971520|512"), /is 10737418239 bytes, not 10737418240/],
  ["a backing image one byte over 10 GiB", withFile("regular file|0|0|600|10737418241|20971521|512"), /is 10737418241 bytes/],
  ["a sparse backing image", withFile("regular file|0|0|600|10737418240|8|512"), /not fully allocated/],
  ["a backing image one block short of full allocation", withFile("regular file|0|0|600|10737418240|20971519|512"), /not fully allocated/],
  ["an unmounted workspace", { FX_MOUNT: "__FAIL__" }, /is not a mountpoint/],
  ["two mounts stacked on the mount point", { FX_MOUNT: `/dev/loop0 ext4 ${GOOD_OPTIONS}\n/dev/loop1 ext4 ${GOOD_OPTIONS}` }, /exactly one mount/],
  ["a non-ext4 filesystem", { FX_MOUNT: `/dev/loop0 xfs ${GOOD_OPTIONS}` }, /is xfs, not ext4/],
  ["the retired tmpfs", { FX_MOUNT: `tmpfs tmpfs ${GOOD_OPTIONS}` }, /is tmpfs, not ext4/],
  ["a mount that is not on a loop device", { FX_MOUNT: `/dev/vda1 ext4 ${GOOD_OPTIONS}` }, /not backed by a loop device/],
  ["a loop device backed by another file", { FX_LOOP: "/var/lib/videofetch-workspace/other.ext4" }, /backed by '\/var\/lib\/videofetch-workspace\/other\.ext4'/],
  ["a loop device whose backing file was deleted", { FX_LOOP: `${BACKING} (deleted)` }, /\(deleted\)', not/],
  ["an unreadable loop device", { FX_LOOP: "__FAIL__" }, /backing file cannot be read/],
  ["a mount without nodev", withOptions("rw,nosuid,noexec,noatime"), /missing mount option nodev/],
  ["a mount without nosuid", withOptions("rw,nodev,noexec,noatime"), /missing mount option nosuid/],
  ["a mount without noexec", withOptions("rw,nosuid,nodev,noatime"), /missing mount option noexec/],
  ["a mount without noatime", withOptions("rw,nosuid,nodev,noexec,relatime"), /missing mount option noatime/],
  ["a read-only mount", withOptions("ro,nosuid,nodev,noexec,noatime"), /missing mount option rw/],
  ["a mount with discard", withOptions(`${GOOD_OPTIONS},discard`), /forbidden mount option discard/],
  ["a mount with exec", withOptions(`${GOOD_OPTIONS},exec`), /forbidden mount option exec/],
  ["a mount with suid", withOptions(`${GOOD_OPTIONS},suid`), /forbidden mount option suid/],
  ["a mount with dev", withOptions(`${GOOD_OPTIONS},dev`), /forbidden mount option dev/],
  ["an uninspectable workspace", { FX_WORKSPACE: "__FAIL__" }, /workspace \/srv\/videofetch\/media\/workspace cannot be inspected/],
  ["a workspace that is a symlink", { FX_WORKSPACE: "symbolic link|1000|1000|777|2049" }, /not a real directory \(symbolic link\)/],
  ["a workspace owned by root", { FX_WORKSPACE: "directory|0|1000|700|2049" }, /owned 0:1000, not 1000:1000/],
  ["a workspace in the wrong group", { FX_WORKSPACE: "directory|1000|0|700|2049" }, /owned 1000:0, not 1000:1000/],
  ["a workspace with mode 0755", { FX_WORKSPACE: "directory|1000|1000|755|2049" }, /mode 755 is not 700/],
  ["a group-writable workspace", { FX_WORKSPACE: "directory|1000|1000|770|2049" }, /mode 770 is not 700/],
  ["a workspace on another filesystem", { FX_WORKSPACE: "directory|1000|1000|700|2050" }, /not on the \/srv\/videofetch\/media filesystem/],
  ["a filesystem one byte below 9 GiB in total", { FX_CAPACITY: "1|9663676415|9663676415" }, /holds 9663676415 bytes, below the required 9663676416/],
  ["an unreadable capacity", { FX_CAPACITY: "4096|many|1" }, /capacity is not numeric/],
];

describe("vf-media-workspace-verify (MAX-FILE-SIZE-4GIB)", () => {
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "vf-media-verify-"));
  });

  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("is valid bash (bash -n)", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("verifies a correct workspace without --wipe, and never wipes", async () => {
    const run = await runVerifier({});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK - \/srv\/videofetch\/media verified$/m);
    assert.ok(!run.events.includes("wipe"));
  });

  it("with --wipe: proves identity first, then wipes exactly the workspace, then re-proves it empty", async () => {
    const run = await runVerifier({}, ["--wipe"]);
    assert.equal(run.status, 0, run.stderr);
    const wipeAt = run.events.indexOf("wipe");
    assert.ok(wipeAt > 0, run.events.join(","));
    for (const probe of [
      "euid",
      `file:${BACKING}`,
      `mount:${MOUNT_POINT}`,
      "loop:/dev/loop0",
      `dir:${WORKSPACE}`,
      `dir:${MOUNT_POINT}`,
      `capacity:${WORKSPACE}`,
    ]) {
      const at = run.events.indexOf(probe);
      assert.ok(at >= 0 && at < wipeAt, `${probe} must be proven before the wipe`);
    }
    assert.deepEqual(run.events.slice(wipeAt), [
      "wipe",
      `wipe-target:${WORKSPACE}`,
      `dir:${WORKSPACE}`,
      `dir:${MOUNT_POINT}`,
      `list:${WORKSPACE}`,
      `capacity:${WORKSPACE}`,
    ]);
    assert.match(run.stdout, /wiped$/m);
  });

  for (const [label, fixture, message] of REFUSALS) {
    it(`refuses ${label}, and never wipes`, async () => {
      const run = await runVerifier(fixture, ["--wipe"]);
      assert.equal(run.status, 1, `${label}: ${run.stderr}`);
      assert.match(run.stderr, message);
      assert.ok(!run.events.includes("wipe"), `${label}: nothing may be wiped`);
    });
  }

  it("accepts exactly 9 GiB total and available", async () => {
    const exact = "1|9663676416|9663676416";
    const run = await runVerifier({ FX_CAPACITY: exact, FX_CAPACITY_AFTER_WIPE: exact }, ["--wipe"]);
    assert.equal(run.status, 0, run.stderr);
  });

  it("measures AVAILABLE capacity after the wipe, so crash residue does not block restarts", async () => {
    const run = await runVerifier(
      { FX_CAPACITY: "1|10737418240|1", FX_CAPACITY_AFTER_WIPE: "1|10737418240|9663676416" },
      ["--wipe"],
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.events.includes("wipe"));
  });

  it("refuses one byte below 9 GiB available after the wipe", async () => {
    const run = await runVerifier({ FX_CAPACITY_AFTER_WIPE: "1|10737418240|9663676415" }, ["--wipe"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /9663676415 bytes available, below the required 9663676416/);
  });

  it("without --wipe, refuses available capacity below 9 GiB and wipes nothing", async () => {
    const run = await runVerifier({ FX_CAPACITY: "1|10737418240|9663676415" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /available, below the required 9663676416/);
    assert.ok(!run.events.includes("wipe"));
  });

  it("a failed wipe keeps the Worker down", async () => {
    const run = await runVerifier({ FX_WIPE_EXIT: "1" }, ["--wipe"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /wiping \/srv\/videofetch\/media\/workspace failed/);
  });

  it("a workspace that is not empty after the wipe keeps the Worker down", async () => {
    const run = await runVerifier({ FX_LISTING_AFTER_WIPE: "/srv/videofetch/media/workspace/jobs\n" }, ["--wipe"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not empty after the wipe/);
  });

  it("a workspace whose identity changed across the wipe keeps the Worker down", async () => {
    const run = await runVerifier({ FX_WORKSPACE_AFTER_WIPE: "symbolic link|1000|1000|777|2049" }, ["--wipe"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a real directory/);
  });

  it("accepts no argument but --wipe, and refuses before inspecting anything", async () => {
    for (const args of [["--force"], ["--wipe", "--wipe"], ["--wipe=1"], ["/srv/elsewhere"], ["--wipe", "/srv/elsewhere"]]) {
      const run = await runVerifier({}, args);
      assert.equal(run.status, 2, args.join(" "));
      assert.match(run.stderr, /usage: vf-media-workspace-verify \[--wipe\]/);
      assert.deepEqual(run.events, [], `${args.join(" ")}: nothing may be probed`);
    }
  });

  it("the real wipe removes descendants only, never follows a symlink, and keeps the directory and its mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-media-wipe-"));
    try {
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      await mkdir(join(workspace, "jobs", "0123456789abcdef0123456789abcdef"), { recursive: true });
      await writeFile(join(workspace, "jobs", "0123456789abcdef0123456789abcdef", "source.mp4"), "media");
      await writeFile(join(workspace, "stray.part"), "partial");
      await mkdir(outside);
      await writeFile(join(outside, "keep.txt"), "keep");
      await symlink(outside, join(workspace, "escape-directory"));
      await symlink(join(outside, "keep.txt"), join(workspace, "escape-file"));
      await chmod(workspace, 0o700);

      const result = spawnSync(
        "bash",
        ["-c", 'set -euo pipefail; source "$VF_SCRIPT"; vf_wipe_workspace "$1"; listing="$(vf_list_workspace "$1")"; [ -z "$listing" ]', "wipe", workspace],
        { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VF_SCRIPT: SCRIPT }, encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await readdir(workspace), [], "every descendant is gone");
      assert.equal((await stat(workspace)).mode & 0o777, 0o700, "the directory and its mode survive");
      assert.deepEqual(await readdir(outside), ["keep.txt"], "a symlink target outside is never touched");
      assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compiles in every path and size, and takes none from arguments or the environment", async () => {
    const source = await readFile(SCRIPT, "utf8");
    for (const line of [
      `VF_BACKING_FILE=${BACKING}`,
      `VF_MOUNT_POINT=${MOUNT_POINT}`,
      `VF_WORKSPACE=${WORKSPACE}`,
      "VF_BACKING_BYTES=10737418240",
      "VF_MIN_WORKSPACE_BYTES=9663676416",
      "VF_WORKSPACE_UID=1000",
      "VF_WORKSPACE_GID=1000",
      "VF_WORKSPACE_MODE=700",
    ]) {
      assert.ok(source.split("\n").includes(line), `missing reviewed constant: ${line}`);
    }
    assert.equal(10_737_418_240, 10 * 2 ** 30, "the backing image is exactly 10 GiB");
    assert.equal(9_663_676_416, 2 * 4 * 2 ** 30 + 2 ** 30, "8 GiB hard media peak + 1 GiB headroom");
    assert.doesNotMatch(source, /^VF_[A-Z_]+="?\$\{/m, "no constant may be overridable from the environment");
    assert.match(source, /find -P "\$1" -xdev -mindepth 1 -delete/, "the one destructive command");
    assert.doesNotMatch(source, /\brm\s+-/);
    assert.doesNotMatch(source, /find -L\b/);
    assert.doesNotMatch(
      source,
      /\bmkfs|\bmke2fs|\bfallocate\b|\bfstrim\b|losetup\s+(-f|--find|-d|--detach)/,
      "the verifier never provisions, attaches, detaches or trims",
    );
  });
});
