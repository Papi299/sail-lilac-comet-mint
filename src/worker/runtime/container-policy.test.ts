import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { YTDLP_RUNTIME } from "./ytdlp-runtime.server.ts";

/**
 * Static container policy guard (§43).
 *
 * Asserts the SEMANTICS of `Dockerfile.worker`, never its formatting. Comments
 * are stripped and line continuations are joined first, so reordering,
 * rewrapping or re-commenting the file cannot fail this suite — only an actual
 * policy regression can.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCKERFILE = join(REPO_ROOT, "Dockerfile.worker");

type Instruction = { directive: string; args: string };

/** Strips comments, joins `\` continuations, and splits into instructions. */
function parseDockerfile(source: string): Instruction[] {
  const logical: string[] = [];
  let buffer = "";

  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // A comment line is never part of a continuation in Docker's parser.
    if (/^\s*#/.test(line)) continue;
    if (buffer === "" && line.trim() === "") continue;

    if (/\\\s*$/.test(line)) {
      buffer += line.replace(/\\\s*$/, " ");
      continue;
    }
    buffer += line;
    if (buffer.trim().length > 0) logical.push(buffer.trim());
    buffer = "";
  }
  if (buffer.trim().length > 0) logical.push(buffer.trim());

  return logical.map((entry) => {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(entry);
    return {
      directive: (match?.[1] ?? "").toUpperCase(),
      args: (match?.[2] ?? "").trim(),
    };
  });
}

describe("Dockerfile.worker container policy", () => {
  let source: string;
  let instructions: Instruction[];
  /** Everything the image actually EXECUTES, comments excluded. */
  let executable: string;

  function directives(name: string): Instruction[] {
    return instructions.filter((i) => i.directive === name.toUpperCase());
  }

  before(async () => {
    source = await readFile(DOCKERFILE, "utf8");
    instructions = parseDockerfile(source);
    executable = instructions.map((i) => `${i.directive} ${i.args}`).join("\n");
  });

  it("exists and is a dedicated Worker artefact", () => {
    assert.ok(source.length > 0, "Dockerfile.worker must exist and be non-empty");
    assert.ok(instructions.length > 0, "Dockerfile.worker must contain instructions");
  });

  // LD-3e replaced "exactly one build stage" (a single FROM) with the three
  // assertions below. The image still has exactly ONE external base image, the
  // Node 22 Bookworm slim family; the only other stage is the patched yt-dlp
  // build, which derives from that same base, so it adds no image, no package
  // source and no interpreter, and the final stage is that base again.
  it("builds on the Node 22 Bookworm slim family", () => {
    const from = directives("FROM");
    assert.match(from[0].args, /^node:22[.\w-]*-bookworm-slim\s+AS\s+worker-base$/i, "Node 22 Bookworm slim base, named worker-base");
    const external = from.filter((f) => !/^(worker-base|ytdlp-build)\b/i.test(f.args));
    assert.equal(external.length, 1, "exactly one external base image");
  });

  it("has exactly the base, the yt-dlp build and the final stage, all from the one base", () => {
    const from = directives("FROM").map((f) => f.args);
    assert.deepEqual(
      from.map((f) => f.replace(/\s+/g, " ")),
      [from[0].replace(/\s+/g, " "), "worker-base AS ytdlp-build", "worker-base"],
      "stages: worker-base, ytdlp-build (FROM worker-base), the final stage (FROM worker-base)",
    );
  });

  it("runs the final stage's instructions only after its own FROM", () => {
    const lastFrom = instructions.map((i) => i.directive).lastIndexOf("FROM");
    const finalStage = instructions.slice(lastFrom + 1);
    for (const directive of ["USER", "CMD", "ENV", "EXPOSE", "WORKDIR"]) {
      assert.ok(finalStage.some((i) => i.directive === directive), `${directive} belongs to the final stage`);
    }
    const buildStage = instructions.slice(
      instructions.findIndex((i) => i.directive === "FROM" && /AS\s+ytdlp-build/i.test(i.args)) + 1,
      lastFrom,
    );
    assert.deepEqual(
      buildStage.map((i) => i.directive),
      ["ADD", "COPY", "RUN"],
      "the build stage only fetches the upstream asset, copies the vendored patch and runs the builder",
    );
  });

  describe("does NOT", () => {
    it("run Vite, Nitro, a dev server or npm preview", () => {
      for (const forbidden of [/\bvite\b/i, /\bnitro\b/i, /npm\s+run\s+preview/i, /npm\s+run\s+dev/i, /npm\s+run\s+build/i, /\bpreview\b/i]) {
        assert.doesNotMatch(
          executable,
          forbidden,
          `the Worker image must not reference ${forbidden}`,
        );
      }
    });

    it("leave the final runtime as root", () => {
      const users = directives("USER");
      assert.ok(users.length > 0, "an explicit USER directive is required");

      const finalUser = users[users.length - 1].args.trim();
      assert.ok(finalUser.length > 0, "the final USER must name an identity");
      assert.notEqual(finalUser, "root", "the final runtime user must not be root");
      assert.doesNotMatch(finalUser, /^0(:|$)/, "the final runtime user must not be UID 0");
    });

    it("install firewall, remote-administration or container-control tooling", () => {
      // PHASE-10C1: `yt-dlp` was removed from this list, and ONLY `yt-dlp`.
      //
      // The image now ships a pinned yt-dlp runtime, but it must never arrive
      // through a PACKAGE MANAGER: apt would track a distribution's moving
      // version and pip would pull an unpinned dependency graph and leave an
      // installer in the image. The artifact is fetched by exact digest
      // instead, which the "pinned yt-dlp runtime" suite below asserts.
      // `youtube-dl` remains banned outright — it is not the approved runtime.
      const forbidden = [
        "nftables", "iptables", "ip6tables", "ufw", "firewalld",
        "curl", "wget", "openssh-server", "openssh-client", "ssh", "sudo",
        "docker.io", "docker-ce", "containerd",
        "youtube-dl",
      ];

      const installCommands = directives("RUN")
        .map((i) => i.args)
        .filter((args) => /\b(apt-get|apt|pip3?|pipx)\b/.test(args));

      for (const command of installCommands) {
        for (const pkg of forbidden) {
          assert.doesNotMatch(
            command,
            new RegExp(`(^|[\\s=])${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s=]|$)`),
            `the Worker image must not install ${pkg}`,
          );
        }
      }
    });

    it("grant itself network-administration capability", () => {
      assert.doesNotMatch(executable, /NET_ADMIN/i);
      assert.doesNotMatch(executable, /--privileged/i);
      assert.doesNotMatch(executable, /docker\.sock/i);
      assert.doesNotMatch(executable, /setcap/i);
      assert.doesNotMatch(executable, /\bchmod\s+[ug]?\+s\b/i, "no setuid helper");
    });

    it("declare an in-container HEALTHCHECK", () => {
      // Phase-8B architectural invariant. The deployed Worker runs inside a
      // media network namespace whose externally-owned safe-egress policy
      // denies loopback and private destinations, so an in-container liveness
      // probe could only pass by weakening that policy. Liveness is probed by
      // the deployment layer from OUTSIDE the namespace instead.
      assert.equal(
        directives("HEALTHCHECK").length,
        0,
        "the Worker image must not declare a HEALTHCHECK",
      );
      assert.doesNotMatch(
        executable,
        /\bHEALTHCHECK\b/i,
        "no executable instruction may reintroduce a healthcheck",
      );
    });

    it("probe any loopback or private destination from inside the image", () => {
      // Closes the obvious workaround: swapping the healthcheck for some other
      // in-namespace probe against a destination the egress policy forbids.
      for (const forbidden of [/127\.0\.0\.1/, /\blocalhost\b/i, /\[::1\]/, /::1\b/]) {
        assert.doesNotMatch(
          executable,
          forbidden,
          `the image must not target ${forbidden} from inside the media namespace`,
        );
      }
    });

    it("carry the retired YTDLP_NETWORK_ISOLATED or YTDLP_PATH contracts at all", () => {
      // STRENGTHENED in Phase 10C1. The old assertion only forbade TRUTHY
      // values, so an image shipping `=false` passed while still carrying a
      // dead contract. Both variables are now retired and the Worker runtime
      // refuses to start if either is present at any value, so the image must
      // not declare them at all.
      for (const retired of ["YTDLP_NETWORK_ISOLATED", "YTDLP_PATH"]) {
        assert.doesNotMatch(
          executable,
          new RegExp(`\\b${retired}\\s*=`),
          `${retired} is retired and must not be declared in the image`,
        );
      }
    });

    it("enable the generic yt-dlp feature", () => {
      // Shipping the runtime must never be the same act as enabling it. An
      // image that switched the feature on by itself would make every
      // deployment of that image generically capable without a decision.
      assert.doesNotMatch(
        executable,
        /\bYTDLP_ENABLED\s*=/,
        "the image must not set YTDLP_ENABLED; absent means disabled",
      );
    });

    it("install or retain a Python package installer", () => {
      // No pip, no venv, no runtime installer: the artifact is a single
      // digest-pinned file, so nothing in this image can add, upgrade or
      // replace a Python package.
      for (const forbidden of [/\bpip3?\b/, /\bpipx\b/, /\bensurepip\b/, /\bvenv\b/, /virtualenv/]) {
        assert.doesNotMatch(
          executable,
          forbidden,
          `the Worker image must not reference ${forbidden}`,
        );
      }
    });

    it("permit yt-dlp to update itself", () => {
      for (const forbidden of [/--update-to/, /--update\b/, /\s-U\s/]) {
        assert.doesNotMatch(
          executable,
          forbidden,
          `the image must not contain a yt-dlp self-update invocation (${forbidden})`,
        );
      }
    });

    it("bake any Worker or object-store secret into the image", () => {
      const secretNames = [
        "WORKER_CONTROL_SECRET",
        "WORKER_CONTROL_PREVIOUS_SECRET",
        "R2_WRITER_ACCESS_KEY_ID",
        "R2_WRITER_SECRET_ACCESS_KEY",
        "R2_WRITER_SESSION_TOKEN",
        "R2_SIGNER_ACCESS_KEY_ID",
        "R2_SIGNER_SECRET_ACCESS_KEY",
        // The R2 parent credential belongs to the trusted host broker alone
        // (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001). It must never be baked
        // into, or declared by, the media image.
        "R2_BROKER_PARENT_ACCESS_KEY_ID",
        "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
        "VIDEOFETCH_ACCESS_SECRET",
      ];

      const assignments = [...directives("ENV"), ...directives("ARG")]
        .map((i) => i.args)
        .join("\n");

      for (const name of secretNames) {
        assert.doesNotMatch(
          assignments,
          new RegExp(`\\b${name}\\s*=`, "i"),
          `${name} must never be assigned in the image`,
        );
      }
    });

    it("ship the trusted credential broker's source", () => {
      // The broker runs on the VM host, outside this network namespace, and is
      // the sole holder of the parent R2 credential. The media image must not
      // contain code that knows how to mint from a parent secret.
      assert.match(
        executable,
        /rm\s+-rf[^\n]*\.\/src\/broker/,
        "the broker source must be removed from the Worker image",
      );
    });

    it("declare any R2 credential of any generation", () => {
      const assignments = [...directives("ENV"), ...directives("ARG")]
        .map((i) => i.args)
        .join("\n");

      // A location and a socket path are fine; key material is not.
      for (const forbidden of [
        /R2_WRITER_[A-Z_]*\s*=/,
        /R2_SIGNER_[A-Z_]*\s*=/,
        /R2_BROKER_PARENT_[A-Z_]*\s*=/,
      ]) {
        assert.doesNotMatch(
          assignments,
          forbidden,
          `the Worker image must not declare ${forbidden}`,
        );
      }
    });

    it("use npm install anywhere — local OR global", () => {
      // Installation is always `ci`. There is no global-toolchain exception:
      // `npm install -g` is rejected exactly like a local `npm install`.
      const runs = directives("RUN").map((i) => i.args);
      for (const command of runs) {
        assert.doesNotMatch(
          command,
          /npm\s+(install|i)\b/,
          `dependencies must be installed with npm ci, found: ${command}`,
        );
      }
    });

    it("contain a literal npm install in any executable instruction", () => {
      // Belt-and-braces over the whole executable surface (RUN, CMD,
      // ENTRYPOINT, HEALTHCHECK), not just RUN.
      assert.doesNotMatch(executable, /npm\s+install\b/);
      assert.doesNotMatch(executable, /npm\s+i\b/);
    });
  });

  describe("does", () => {
    it("execute the Worker runtime entry point", () => {
      const cmds = directives("CMD");
      assert.equal(cmds.length, 1, "exactly one CMD");
      assert.match(
        cmds[0].args,
        /src\/worker\/runtime\/main\.server\.ts/,
        "CMD must launch the Worker runtime",
      );
      assert.match(cmds[0].args, /^\s*\[/, "CMD should use exec form");
      assert.match(cmds[0].args, /"node"/, "CMD must invoke Node directly");
    });

    it("install the Python interpreter the pinned yt-dlp release requires", () => {
      const installs = directives("RUN")
        .map((i) => i.args)
        .filter((args) => /apt-get\s+install/.test(args))
        .join("\n");
      // Debian Bookworm's system python3 is 3.11, satisfying the pinned
      // release's >= 3.10 requirement with no venv and no pip.
      assert.match(installs, /(^|\s)python3(\s|$)/, "python3 must be installed");
    });

    it("install ffmpeg and CA certificates", () => {
      const installs = directives("RUN")
        .map((i) => i.args)
        .filter((args) => /apt-get\s+install/.test(args))
        .join("\n");

      assert.match(installs, /(^|\s)ffmpeg(\s|$)/, "ffmpeg must be installed");
      assert.match(installs, /(^|\s)ca-certificates(\s|$)/, "ca-certificates must be installed");
    });

    it("install production dependencies with npm ci", () => {
      const runs = directives("RUN").map((i) => i.args).join("\n");
      // Accepts both `npm ci` and an exact-pinned ephemeral runner such as
      // `npx --yes npm@11.19.1 ci`. Either way the verb is `ci`.
      assert.match(
        runs,
        /npm(@[\w.-]+)?\s+ci\b/,
        "dependencies must be installed with npm ci",
      );
      assert.match(runs, /--omit=dev\b/, "the production image omits devDependencies");
    });

    it("pin an exact version when bootstrapping an npm toolchain", () => {
      const runs = directives("RUN").map((i) => i.args).join("\n");
      if (!/\bnpx\b/.test(runs)) return; // no bootstrap in use
      assert.match(
        runs,
        /npx[^\n]*\snpm@\d+\.\d+\.\d+\s/,
        "an npx npm bootstrap must pin an exact version",
      );
      assert.match(
        runs,
        /rm\s+-rf[^\n]*_npx/,
        "the fetched toolchain must not be retained in the final image",
      );
    });

    it("declare a non-root runtime user before the final CMD", () => {
      const lastIndexOf = (directive: string): number => {
        for (let i = instructions.length - 1; i >= 0; i -= 1) {
          if (instructions[i].directive === directive) return i;
        }
        return -1;
      };

      const userIndex = lastIndexOf("USER");
      const cmdIndex = lastIndexOf("CMD");

      assert.ok(userIndex >= 0, "a USER directive is required");
      assert.ok(cmdIndex >= 0, "a CMD directive is required");
      assert.ok(userIndex < cmdIndex, "USER must precede the final CMD");
    });

    it("declare the persistent state and ephemeral temp directory contract", () => {
      const env = directives("ENV").map((i) => i.args).join("\n");

      const dataDir = /WORKER_DATA_DIRECTORY\s*=\s*(\S+)/.exec(env)?.[1];
      assert.ok(dataDir, "WORKER_DATA_DIRECTORY must be declared");
      assert.ok(dataDir.startsWith("/"), "the state directory must be absolute");
      assert.ok(
        !dataDir.startsWith("/tmp"),
        "durable SQLite state must never live under /tmp",
      );

      const tempDir = /TEMP_DIRECTORY\s*=\s*(\S+)/.exec(env)?.[1];
      assert.ok(tempDir, "TEMP_DIRECTORY must be declared");
      assert.notEqual(tempDir, dataDir, "media temp must not share the durable state volume");
      assert.ok(
        !tempDir.startsWith(dataDir!),
        "media must never be written under the SQLite volume",
      );
    });

    it("prepare the runtime directories for the non-root user", () => {
      const runs = directives("RUN").map((i) => i.args).join("\n");
      assert.match(runs, /mkdir\s+-p[^\n]*\/var\/lib\/videofetch/, "state mountpoint prepared");
      assert.match(runs, /chown[^\n]*node/, "ownership handed to the non-root runtime user");
    });
  });

  // ── pinned yt-dlp runtime (PHASE-10C1; patched build since LD-3e) ─────────
  //
  // The image and `ytdlp-runtime.server.ts` must describe the SAME runtime.
  // Asserting them against each other — rather than against a literal repeated
  // in the test — means a version bump that touches only one of the two fails
  // here instead of shipping a Worker whose probe can never match its image.
  //
  // LD-3e changed WHAT is installed: the upstream asset is fetched into a build
  // stage and the reviewed builder replaces two members. Every PHASE-10C1
  // assertion below survives with its subject made precise: "the" artifact is
  // now the UPSTREAM asset where it is fetched (ADD, its URL and digest, never
  // mutable or self-extracting) and the BUILT artifact where it is installed
  // (path, owner, mode, writable mounts). New assertions cover the build step,
  // its network isolation, the final digest and what reaches the final stage.
  describe("pinned yt-dlp runtime", () => {
    function addDirectives(): string[] {
      return directives("ADD").map((i) => i.args);
    }
    function stageOf(index: number): string {
      for (let i = index; i >= 0; i -= 1) {
        if (instructions[i].directive === "FROM") return instructions[i].args.replace(/\s+/g, " ");
      }
      return "";
    }
    const VENDORED = "vendor/yt-dlp/2026.08.19-videofetch-ld3e/";

    it("fetches exactly one yt-dlp artifact, by ADD, with no download tooling", () => {
      const adds = addDirectives().filter((args) => args.includes("yt-dlp"));
      assert.equal(adds.length, 1, "exactly one yt-dlp artifact may be added");
      // ADD --checksum verifies at build time and needs no curl or wget in any
      // image, which is what keeps both out of the runtime.
      assert.doesNotMatch(executable, /\bcurl\b/, "no curl anywhere in the image");
      assert.doesNotMatch(executable, /\bwget\b/, "no wget anywhere in the image");
      assert.equal(directives("ADD").length, 1, "nothing else is fetched by ADD");
    });

    it("fetches the upstream asset only into the build stage", () => {
      const index = instructions.findIndex((i) => i.directive === "ADD" && i.args.includes("yt-dlp"));
      assert.equal(stageOf(index), "worker-base AS ytdlp-build", "the upstream asset is fetched in the build stage");
      assert.match(instructions[index].args, /\s\/build\/upstream\/yt-dlp$/, "into the build stage's input path");
    });

    it("pins the exact version the runtime module expects", () => {
      const add = addDirectives().find((args) => args.includes("yt-dlp"))!;
      assert.ok(
        add.includes(YTDLP_RUNTIME.upstream.releaseUrl),
        "the image must fetch the exact release URL the runtime module pins",
      );
      assert.ok(
        add.includes(`/${YTDLP_RUNTIME.upstream.version}/`),
        "the fetched URL must carry the expected upstream version",
      );
      assert.ok(
        YTDLP_RUNTIME.expectedVersion.startsWith(`${YTDLP_RUNTIME.upstream.version}+`),
        "the installed identity must name the upstream release it is built from",
      );
    });

    it("pins the exact SHA-256 the runtime module expects", () => {
      const add = addDirectives().find((args) => args.includes("yt-dlp"))!;
      assert.match(add, /--checksum=sha256:[0-9a-f]{64}/, "a sha256 digest must be pinned");
      assert.ok(
        add.includes(`--checksum=sha256:${YTDLP_RUNTIME.upstream.sha256}`),
        "the upstream digest must equal the runtime module's pinned upstream digest",
      );
    });

    it("builds the patched artifact from the vendored patch with the reviewed builder, offline", () => {
      const copies = directives("COPY").map((i) => i.args).filter((args) => args.includes(VENDORED));
      assert.deepEqual(copies, [`${VENDORED} /build/patch/`], "the vendored patch is copied once, into the build stage");
      const builds = instructions
        .map((i, index) => ({ i, index }))
        .filter(({ i }) => i.directive === "RUN" && i.args.includes("build_patched_ytdlp.py"));
      assert.equal(builds.length, 1, "the builder runs exactly once");
      const { i: run, index } = builds[0];
      assert.equal(stageOf(index), "worker-base AS ytdlp-build", "in the build stage");
      assert.match(run.args, /^--network=none\s/, "with no network at all");
      assert.match(
        run.args,
        /(^|\s)python3 -I -B \/build\/patch\/build_patched_ytdlp\.py \/build\/upstream\/yt-dlp \/build\/out\/yt-dlp(\s|$)/,
        "the system interpreter, isolated, on exactly the fetched asset and one new output path",
      );
    });

    it("verifies the built artifact's exact SHA-256 before it can be copied", () => {
      const run = directives("RUN").map((i) => i.args).find((args) => args.includes("build_patched_ytdlp.py"))!;
      assert.ok(
        run.includes(`echo "${YTDLP_RUNTIME.sha256}  /build/out/yt-dlp" | sha256sum --check --strict -`),
        "the build fails closed unless the output digest equals the runtime module's pinned digest",
      );
      assert.notEqual(YTDLP_RUNTIME.sha256, YTDLP_RUNTIME.upstream.sha256, "the installed artifact is the patched build, not the upstream asset");
    });

    it("installs the artifact at the exact path the runtime module executes", () => {
      const copies = instructions
        .map((i, index) => ({ i, index }))
        .filter(({ i }) => i.directive === "COPY" && i.args.includes(YTDLP_RUNTIME.artifactPath));
      assert.equal(copies.length, 1, "the artifact is installed exactly once");
      assert.equal(
        copies[0].i.args,
        `--from=ytdlp-build /build/out/yt-dlp ${YTDLP_RUNTIME.artifactPath}`,
        "the install destination must equal the executed path, and the source is the verified build output",
      );
      assert.equal(stageOf(copies[0].index), "worker-base", "into the final stage");
    });

    it("carries no upstream asset, vendored source or builder into the final stage", () => {
      const lastFrom = instructions.map((i) => i.directive).lastIndexOf("FROM");
      const finalStage = instructions.slice(lastFrom + 1).map((i) => `${i.directive} ${i.args}`).join("\n");
      assert.doesNotMatch(finalStage, /vendor\/yt-dlp|build_patched_ytdlp|\/build\/upstream|\/build\/patch/, "nothing of the build stage but its output");
      assert.equal(
        instructions.slice(lastFrom + 1).filter((i) => i.directive === "ADD").length,
        0,
        "the final stage fetches nothing",
      );
    });

    it("never fetches a mutable or self-extracting artifact", () => {
      const add = addDirectives().find((args) => args.includes("yt-dlp"))!;
      for (const mutable of ["latest", "nightly", "master"]) {
        assert.equal(add.includes(mutable), false, `the URL must not be ${mutable}`);
      }
      // The PyInstaller builds unpack to a temp dir at runtime, which the
      // read-only root and noexec media tmpfs would break.
      for (const variant of ["yt-dlp_linux", "yt-dlp_musllinux", "yt-dlp_macos", ".exe", ".zip"]) {
        assert.equal(add.includes(variant), false, `the artifact must not be ${variant}`);
      }
    });

    it("leaves the artifact root-owned and unwritable by the runtime user", () => {
      const runs = directives("RUN").map((i) => i.args).join("\n");
      assert.match(
        runs,
        new RegExp(`chown\\s+root:root[^\\n]*${YTDLP_RUNTIME.artifactPath}`),
        "the artifact must be root-owned",
      );
      assert.match(
        runs,
        new RegExp(`chmod\\s+0?555[^\\n]*${YTDLP_RUNTIME.artifactPath}`),
        "the artifact must be read-only and not writable by the runtime user",
      );
    });

    it("does not put the artifact on a writable mount", () => {
      // /tmp/videofetch is the media tmpfs (writable, noexec) and
      // /var/lib/videofetch is the durable state volume. The runtime belongs on
      // the read-only root, where the Worker cannot rewrite it.
      for (const writable of ["/tmp/", "/var/lib/videofetch"]) {
        assert.equal(
          YTDLP_RUNTIME.artifactPath.startsWith(writable),
          false,
          `the artifact must not live under ${writable}`,
        );
      }
    });
  });

});
