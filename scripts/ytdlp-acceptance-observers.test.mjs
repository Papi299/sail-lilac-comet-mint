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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  makeSystemObservers,
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
  const image = "alpine:latest";

  /**
   * Can this host observe a container's network namespace END TO END?
   *
   * `networkPlacement()` reads `/proc/<pid>/ns/net` for a PID that
   * `docker inspect {{.State.Pid}}` reported. That is only meaningful where the
   * Docker daemon shares the kernel running these tests — on Docker Desktop the
   * PID belongs to a VM this process has no `/proc` for, so the link is
   * unreadable and the observer correctly measures `null`.
   *
   * The end-to-end tests therefore run where Docker is native (the acceptance
   * VM) and skip elsewhere, rather than being weakened into hand-written
   * observations — which is precisely the defect this file exists to prevent.
   */
  function canObserveNamespacesEndToEnd() {
    if (!haveDocker || process.platform !== "linux") return false;
    try {
      execFileSync("readlink", [`/proc/${process.pid}/ns/net`], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  const endToEnd = canObserveNamespacesEndToEnd() && imageAvailable(image);

  /**
   * Creates disposable containers and guarantees their removal.
   *
   * `async` + `await body()` is load-bearing: a synchronous wrapper's `finally`
   * fires the moment an async body RETURNS ITS PROMISE, which tore the
   * containers down before the observer ever ran. That produced a green
   * "missing holder" result for entirely the wrong reason — caught only because
   * these tests now execute the real observer.
   */
  async function withContainers(specs, body) {
    const created = [];
    try {
      for (const [name, args] of specs) {
        execFileSync("docker", ["run", "-d", "--name", name, ...args, image, "sleep", "120"], { stdio: "pipe" });
        created.push(name);
      }
      return await body();
    } finally {
      for (const name of created.reverse()) {
        try {
          execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
        } catch {
          /* already gone */
        }
      }
    }
  }

  const inspect = (name, format) =>
    execFileSync("docker", ["inspect", "--format", format, name], { encoding: "utf8" }).trim();

  const unique = () => randomUUID().slice(0, 8);

  it("rejects the string the retired check required", () => {
    // Docker never renders a running container's NetworkMode this way. The
    // retired evaluator required exactly this, which is why a correctly placed
    // Worker FAILED in run 5e6670a858543d93.
    assert.equal(sharesMediaNetworkNamespace(`container:${MEDIA_NETNS_CONTAINER}`), false);
    assert.equal(CONTAINER_NETWORK_MODE_PATTERN.test(`container:${MEDIA_NETNS_CONTAINER}`), false);
  });

  it("Docker stores the RESOLVED id, never the name", { skip: !(haveDocker && imageAvailable(image)) }, async () => {
    const holder = `vf-netns-holder-${unique()}`;
    const joiner = `vf-netns-joiner-${unique()}`;
    await withContainers([[holder, []], [joiner, ["--network", `container:${holder}`]]], () => {
      const rawMode = inspect(joiner, "{{.HostConfig.NetworkMode}}");
      assert.match(rawMode, CONTAINER_NETWORK_MODE_PATTERN, "the decisive fact this remediation rests on");
      assert.equal(rawMode.includes(holder), false, "the NAME is not preserved");
      assert.equal(CONTAINER_NETWORK_MODE_PATTERN.exec(rawMode)[1], inspect(holder, "{{.Id}}"));
    });
  });

  // ── THE PRODUCER-SIDE PROOF ────────────────────────────────────────────────
  //
  //   real containers → makeSystemObservers → networkPlacement()
  //     → real `docker inspect` → real `readlink /proc/<pid>/ns/net`
  //       → measured observation → sharesMediaNetworkNamespace()
  //
  // Nothing in the happy path below is hand-written: every asserted value comes
  // back from the observer and is then compared against the kernel and Docker
  // independently. CORRECTION-01 added this because the first version of the
  // test manufactured the two namespace strings and only exercised the
  // evaluator — reproducing the very weakness under repair.
  it("the REAL observer measures a real namespace-sharing pair", { skip: !endToEnd }, async () => {
    const holder = `vf-netns-holder-${unique()}`;
    const joiner = `vf-netns-joiner-${unique()}`;
    await withContainers([[holder, []], [joiner, ["--network", `container:${holder}`]]], async () => {
      const observers = makeSystemObservers({ container: joiner, mediaNetnsContainer: holder });
      const observation = await observers.networkPlacement();

      assert.equal(observation.measured, true, observation.reason ?? "");
      const v = observation.value;

      // Independently measured truth, read outside the observer.
      const realHolderId = inspect(holder, "{{.Id}}");
      const realJoinerPid = Number(inspect(joiner, "{{.State.Pid}}"));
      const realHolderPid = Number(inspect(holder, "{{.State.Pid}}"));
      const realJoinerNs = execFileSync("readlink", [`/proc/${realJoinerPid}/ns/net`], { encoding: "utf8" }).trim();
      const realHolderNs = execFileSync("readlink", [`/proc/${realHolderPid}/ns/net`], { encoding: "utf8" }).trim();

      // The observer's values must BE those real values — this is the
      // producer-side proof the evaluator alone could never give.
      assert.equal(v.targetContainerId, realHolderId);
      assert.equal(v.mediaNetnsContainerId, realHolderId);
      assert.equal(v.workerPid, realJoinerPid);
      assert.equal(v.mediaNetnsPid, realHolderPid);
      assert.equal(v.workerNetNamespace, realJoinerNs);
      assert.equal(v.mediaNetNamespace, realHolderNs);

      // …and they must be genuine kernel identities that actually agree.
      assert.match(v.workerNetNamespace, NET_NAMESPACE_PATTERN);
      assert.match(v.mediaNetNamespace, NET_NAMESPACE_PATTERN);
      assert.equal(v.workerNetNamespace, v.mediaNetNamespace);

      assert.equal(sharesMediaNetworkNamespace(v), true, "a real shared namespace must PASS");
    });
  });

  it("the REAL observer fails closed when the intended holder is a DIFFERENT container", { skip: !endToEnd }, async () => {
    const holder = `vf-netns-holder-${unique()}`;
    const other = `vf-netns-other-${unique()}`;
    const joiner = `vf-netns-joiner-${unique()}`;
    await withContainers(
      [[holder, []], [other, []], [joiner, ["--network", `container:${holder}`]]],
      async () => {
        const observers = makeSystemObservers({ container: joiner, mediaNetnsContainer: other });
        const observation = await observers.networkPlacement();
        assert.equal(observation.measured, true, "the mismatch is MEASURED, not unobservable");
        assert.notEqual(observation.value.targetContainerId, observation.value.mediaNetnsContainerId);
        assert.equal(sharesMediaNetworkNamespace(observation.value), false,
          "sharing SOME namespace is not sharing the INTENDED one");
      },
    );
  });

  it("the REAL observer fails closed on ordinary bridge networking", { skip: !endToEnd }, async () => {
    const holder = `vf-netns-holder-${unique()}`;
    const bridged = `vf-netns-bridged-${unique()}`;
    await withContainers([[holder, []], [bridged, []]], async () => {
      const observers = makeSystemObservers({ container: bridged, mediaNetnsContainer: holder });
      const observation = await observers.networkPlacement();
      assert.equal(observation.measured, true);
      assert.equal(observation.value.targetContainerId, null, "bridge is not a container-scoped mode");
      assert.equal(sharesMediaNetworkNamespace(observation.value), false);
    });
  });

  it("the REAL observer refuses to measure a MISSING namespace holder", { skip: !endToEnd }, async () => {
    const holder = `vf-netns-holder-${unique()}`;
    const joiner = `vf-netns-joiner-${unique()}`;
    await withContainers([[holder, []], [joiner, ["--network", `container:${holder}`]]], async () => {
      const observers = makeSystemObservers({
        container: joiner,
        mediaNetnsContainer: `vf-netns-absent-${unique()}`,
      });
      const observation = await observers.networkPlacement();
      // `docker inspect` on a container that does not exist EXITS NON-ZERO, so
      // this is an inability to observe — BLOCKED — never a quiet false.
      assert.equal(observation.measured, false, "a missing holder is unobservable, not 'not shared'");
      assert.equal(sharesMediaNetworkNamespace(observation.value), false);
    });
  });

  it("the REAL observer reports a STOPPED namespace holder as not-running", { skip: !endToEnd }, async () => {
    const holder = `vf-netns-holder-${unique()}`;
    const joiner = `vf-netns-joiner-${unique()}`;
    await withContainers([[holder, []], [joiner, ["--network", `container:${holder}`]]], async () => {
      execFileSync("docker", ["stop", "-t", "0", joiner], { stdio: "pipe" });
      const observers = makeSystemObservers({ container: joiner, mediaNetnsContainer: holder });
      const observation = await observers.networkPlacement();
      if (observation.measured) {
        // A stopped container reports PID 0, which normalizes to null.
        assert.equal(observation.value.workerPid, null);
        assert.equal(sharesMediaNetworkNamespace(observation.value), false);
      } else {
        assert.equal(sharesMediaNetworkNamespace(observation.value), false);
      }
    });
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

  it("the production default holder is application-owned and not operator-configurable", () => {
    assert.equal(MEDIA_NETNS_CONTAINER, "videofetch-media-netns");
    // The seam exists for disposable regressions only: no CLI option reaches it.
    const cli = readFileSync(new URL("../deploy/acceptance/ytdlp-generic/acceptance.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(cli, /--media-netns|mediaNetnsContainer/,
      "the namespace holder must never become operator input");
    assert.throws(() => makeSystemObservers({ mediaNetnsContainer: "bad name;rm -rf /" }),
      "a malformed holder name is refused by Docker's own grammar");
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
