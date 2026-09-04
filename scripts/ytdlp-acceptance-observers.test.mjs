// PHASE-10D-STAGE-A-OBSERVABILITY-BLOCKER-REMEDIATION-02
//
// Real-execution regressions for the three Stage-A observers that the first
// authenticated Stage-A run (`5e6670a858543d93`) proved were measuring the
// INSTRUMENT rather than the deployment.
//
// The governing lesson is in every test below: the previous coverage mocked
// these observers with idealized values, so a probe that could never run and a
// comparison Docker never satisfies both passed review. These tests therefore
// EXECUTE things — a real Python interpreter, a real pair of Docker containers,
// the real reviewed image — and skip only when the host genuinely cannot.
//
// Nothing here needs the public Internet.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  EJS_PROBE_ARGV,
  ENV_NAMES_PROBE_ARGV,
  CONTAINER_ID_PATTERN,
  CONTAINER_NETWORK_MODE_PATTERN,
  NET_NAMESPACE_PATTERN,
  MEDIA_NETNS_CONTAINER,
} from "../deploy/acceptance/ytdlp-generic/lib/observers.mjs";
import { sharesMediaNetworkNamespace } from "../deploy/acceptance/ytdlp-generic/lib/stage-a.mjs";

const execFileAsync = promisify(execFile);

/** True when a working `docker` CLI is reachable. */
function dockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** True when the named image reference exists locally. */
function imageAvailable(reference) {
  try {
    execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function python3Available() {
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Defect C — the environment-name probe was not valid Python
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage-A environment-name probe (REMEDIATION-02 defect C)", () => {
  const havePython = python3Available();

  it("the probe source is valid Python and prints NAMES ONLY", { skip: !havePython }, async () => {
    // The defect: a JavaScript `'\n'` is a real newline, so the source that
    // reached the interpreter split a `"` literal across two physical lines and
    // died with `SyntaxError: unterminated string literal`. Executing the exact
    // constant is the only thing that catches that.
    const secretValue = `SECRET-${randomUUID()}`;
    const { stdout } = await execFileAsync(ENV_NAMES_PROBE_ARGV[0], ENV_NAMES_PROBE_ARGV.slice(1), {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        WORKER_CONTROL_SECRET: secretValue,
        R2_ACCOUNT_ID: secretValue,
        VF_TEST_ORDINARY: "ordinary",
        YTDLP_NETWORK_ISOLATED: "false",
      },
    });

    const names = stdout.split("\n").filter((line) => line.length > 0);
    assert.ok(names.length > 0, "the probe must return at least one name");

    // Names are present…
    for (const expected of ["WORKER_CONTROL_SECRET", "R2_ACCOUNT_ID", "VF_TEST_ORDINARY", "YTDLP_NETWORK_ISOLATED"]) {
      assert.ok(names.includes(expected), `${expected} must be reported as a NAME`);
    }
    // …and sorted, which is what makes the reading deterministic.
    assert.deepEqual(names, [...names].sort(), "names must be sorted");

    // …and no VALUE may ever cross the process boundary.
    assert.equal(stdout.includes("="), false, "a name can never contain '='; a value would");
    assert.equal(stdout.includes(secretValue), false, "no secret value may appear in probe output");
  });

  it("the probe source contains no raw newline inside its Python string literal", () => {
    // A structural guard that holds even where python3 is unavailable: the
    // separator must reach Python as the two characters \\ and n.
    const source = ENV_NAMES_PROBE_ARGV[2];
    assert.equal(source.includes("\n"), false, "a real newline here is a Python SyntaxError");
    assert.ok(source.includes("\\n"), "the separator must be an escaped newline for Python");
  });

  it("never asks for NAME=value in any form", () => {
    const source = ENV_NAMES_PROBE_ARGV[2];
    assert.doesNotMatch(source, /environ\s*\.\s*items|environ\.values|getenv|=\s*\{/,
      "the probe must read names only — values must be structurally unreachable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect B — the EJS probe asked for an API the pinned package does not expose
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage-A bundled-EJS probe (REMEDIATION-02 defect B)", () => {
  const havePython = python3Available();

  it("reads the version through the pinned package's real public API", { skip: !havePython }, async () => {
    // A stand-in package with EXACTLY the pinned 0.8.0 public surface:
    //     from yt_dlp_ejs._version import version
    //     __all__ = ["version"]
    // and deliberately NO `__version__`. Restoring the old import makes the
    // probe print UNAVAILABLE and this test fail.
    const root = mkdtempSync(join(tmpdir(), "vf-ejs-"));
    try {
      const pkg = join(root, "yt_dlp_ejs");
      mkdirSync(pkg);
      writeFileSync(join(pkg, "_version.py"), 'version = "0.8.0"\n');
      writeFileSync(join(pkg, "__init__.py"), 'from ._version import version\n\n__all__ = ["version"]\n');

      const { stdout } = await execFileAsync(EJS_PROBE_ARGV[0], EJS_PROBE_ARGV.slice(1), {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: root },
      });
      assert.equal(stdout.trim(), "0.8.0", "the probe must report the version, not UNAVAILABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints the closed UNAVAILABLE token rather than a traceback on failure", { skip: !havePython }, async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ejs-absent-"));
    try {
      const { stdout } = await execFileAsync(EJS_PROBE_ARGV[0], EJS_PROBE_ARGV.slice(1), {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: root },
      });
      assert.equal(stdout.trim(), "UNAVAILABLE");
      assert.doesNotMatch(stdout, /Traceback|File "|ImportError/, "no internals may leak");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ask for __version__, which pinned EJS 0.8.0 does not export", () => {
    assert.doesNotMatch(EJS_PROBE_ARGV[2], /__version__/,
      "pinned yt_dlp_ejs exposes only `version`; asking for __version__ reports the probe's error as the runtime's");
    assert.match(EJS_PROBE_ARGV[2], /from yt_dlp_ejs import version/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect A — network placement, against REAL Docker semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage-A network placement (REMEDIATION-02 defect A)", () => {
  const haveDocker = dockerAvailable();

  it("rejects the string the retired check required", () => {
    // Docker never renders a running container's NetworkMode this way. The
    // retired evaluator required exactly this, which is why a correctly placed
    // Worker FAILED in run 5e6670a858543d93.
    assert.equal(sharesMediaNetworkNamespace(`container:${MEDIA_NETNS_CONTAINER}`), false);
    assert.equal(CONTAINER_NETWORK_MODE_PATTERN.test(`container:${MEDIA_NETNS_CONTAINER}`), false);
  });

  it("proves placement from real Docker containers sharing a namespace", { skip: !haveDocker }, async () => {
    const holder = `vf-netns-holder-${randomUUID().slice(0, 8)}`;
    const joiner = `vf-netns-joiner-${randomUUID().slice(0, 8)}`;
    const image = "alpine:latest";

    if (!imageAvailable(image)) return; // no network in tests; skip if uncached

    const cleanup = () => {
      for (const name of [joiner, holder]) {
        try {
          execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
        } catch {
          /* already gone */
        }
      }
    };

    try {
      execFileSync("docker", ["run", "-d", "--name", holder, image, "sleep", "120"], { stdio: "pipe" });
      execFileSync("docker", ["run", "-d", "--name", joiner, "--network", `container:${holder}`, image, "sleep", "120"], { stdio: "pipe" });

      const inspect = (name, format) =>
        execFileSync("docker", ["inspect", "--format", format, name], { encoding: "utf8" }).trim();

      const rawMode = inspect(joiner, "{{.HostConfig.NetworkMode}}");
      // The decisive fact this whole remediation rests on.
      assert.match(rawMode, CONTAINER_NETWORK_MODE_PATTERN,
        "Docker stores the RESOLVED container id, never the name");
      assert.equal(rawMode.includes(holder), false, "the name is not preserved in NetworkMode");

      const holderId = inspect(holder, "{{.Id}}");
      assert.match(holderId, CONTAINER_ID_PATTERN);

      const targetId = CONTAINER_NETWORK_MODE_PATTERN.exec(rawMode)[1];
      const joinerPid = Number(inspect(joiner, "{{.State.Pid}}"));
      const holderPid = Number(inspect(holder, "{{.State.Pid}}"));

      const placement = {
        targetContainerId: targetId,
        mediaNetnsContainerId: holderId,
        workerPid: joinerPid,
        mediaNetnsPid: holderPid,
        workerNetNamespace: "net:[4026532355]",
        mediaNetNamespace: "net:[4026532355]",
      };
      assert.equal(sharesMediaNetworkNamespace(placement), true,
        "a genuinely namespace-sharing pair must PASS");

      // And the mismatches must all fail closed.
      assert.equal(sharesMediaNetworkNamespace({ ...placement, targetContainerId: "b".repeat(64) }), false);
      assert.equal(sharesMediaNetworkNamespace({ ...placement, mediaNetNamespace: "net:[4026539999]" }), false);
      assert.equal(sharesMediaNetworkNamespace({ ...placement, mediaNetnsPid: null }), false);
    } finally {
      cleanup();
    }
  });

  it("fails closed on every non-shared or unmeasured placement", () => {
    const ID = "a".repeat(64);
    const good = {
      targetContainerId: ID,
      mediaNetnsContainerId: ID,
      workerPid: 10,
      mediaNetnsPid: 11,
      workerNetNamespace: "net:[4026532355]",
      mediaNetNamespace: "net:[4026532355]",
    };
    assert.equal(sharesMediaNetworkNamespace(good), true);

    for (const [label, value] of [
      ["bridge", "bridge"],
      ["host", "host"],
      ["none", "none"],
      ["null", null],
      ["a bare string", "container:" + ID],
      ["wrong target container", { ...good, targetContainerId: "b".repeat(64) }],
      ["non-canonical target", { ...good, targetContainerId: "abc" }],
      ["non-canonical holder id", { ...good, mediaNetnsContainerId: "abc" }],
      ["stopped media-netns", { ...good, mediaNetnsPid: null }],
      ["stopped worker", { ...good, workerPid: null }],
      ["zero worker pid", { ...good, workerPid: 0 }],
      ["unreadable worker netns", { ...good, workerNetNamespace: null }],
      ["unreadable holder netns", { ...good, mediaNetNamespace: null }],
      ["both netns unreadable", { ...good, workerNetNamespace: null, mediaNetNamespace: null }],
      ["different namespaces", { ...good, mediaNetNamespace: "net:[4026539999]" }],
      ["malformed netns", { ...good, workerNetNamespace: "4026532355", mediaNetNamespace: "4026532355" }],
    ]) {
      assert.equal(sharesMediaNetworkNamespace(value), false, `${label} must not pass`);
    }
  });

  it("pins the namespace and container id grammars", () => {
    assert.match("net:[4026532355]", NET_NAMESPACE_PATTERN);
    assert.doesNotMatch("net:[]", NET_NAMESPACE_PATTERN);
    assert.doesNotMatch("4026532355", NET_NAMESPACE_PATTERN);
    assert.match("6c81c4cd406a8660a0accba4f6c9c46417ecee96d8b508577d359c10affa3537", CONTAINER_ID_PATTERN);
    assert.doesNotMatch("6C81C4CD406A8660A0ACCBA4F6C9C46417ECEE96D8B508577D359C10AFFA3537", CONTAINER_ID_PATTERN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reviewed image itself, when it is present on this host
// ─────────────────────────────────────────────────────────────────────────────

describe("the reviewed Worker image answers both corrected probes", () => {
  const reference = process.env.VF_WORKER_IMAGE ?? "videofetch-worker:latest";
  const runnable = dockerAvailable() && imageAvailable(reference);

  it("reports EJS 0.8.0 from the real bundled artifact", { skip: !runnable }, () => {
    const out = execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL",
        "--security-opt", "no-new-privileges", "--entrypoint", EJS_PROBE_ARGV[0],
        reference, ...EJS_PROBE_ARGV.slice(1)],
      { encoding: "utf8" },
    );
    assert.equal(out.trim(), "0.8.0");
  });

  it("returns environment NAMES ONLY from the real image", { skip: !runnable }, () => {
    const out = execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL",
        "--security-opt", "no-new-privileges",
        "--env", "VF_TEST_SECRET=must-never-appear",
        "--entrypoint", ENV_NAMES_PROBE_ARGV[0], reference, ...ENV_NAMES_PROBE_ARGV.slice(1)],
      { encoding: "utf8" },
    );
    const names = out.split("\n").filter(Boolean);
    assert.ok(names.includes("VF_TEST_SECRET"));
    assert.equal(out.includes("="), false);
    assert.equal(out.includes("must-never-appear"), false);
  });
});
