import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

  it("builds on the Node 22 Bookworm slim family", () => {
    const from = directives("FROM");
    assert.equal(from.length, 1, "exactly one build stage");
    assert.match(from[0].args, /^node:22[.\w-]*-bookworm-slim\b/, "Node 22 Bookworm slim base");
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
      const forbidden = [
        "nftables", "iptables", "ip6tables", "ufw", "firewalld",
        "curl", "wget", "openssh-server", "openssh-client", "ssh", "sudo",
        "docker.io", "docker-ce", "containerd",
        "yt-dlp", "youtube-dl",
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

    it("enable YTDLP_NETWORK_ISOLATED", () => {
      // Phase 10 is the only phase authorized to enable it.
      for (const truthy of ["true", "1", "yes"]) {
        assert.doesNotMatch(
          executable,
          new RegExp(`YTDLP_NETWORK_ISOLATED\\s*=\\s*["']?${truthy}["']?(\\s|$)`, "i"),
          `YTDLP_NETWORK_ISOLATED must never be set to ${truthy}`,
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

    it("provide an unauthenticated Worker healthcheck using Node itself", () => {
      const healthchecks = directives("HEALTHCHECK");
      assert.equal(healthchecks.length, 1, "exactly one HEALTHCHECK");

      const check = healthchecks[0].args;
      assert.match(check, /\/v1\/healthz/, "healthcheck must probe /v1/healthz");
      assert.match(check, /\bnode\b/, "healthcheck must use Node, not curl");
      assert.doesNotMatch(check, /\bcurl\b|\bwget\b/, "healthcheck must not shell out to curl/wget");
      assert.doesNotMatch(
        check,
        /\/v1\/diagnostics/,
        "diagnostics is authenticated and must not gate container health",
      );
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
});
