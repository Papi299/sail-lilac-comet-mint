import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Static deployment policy guard for the trusted-broker boundary
 * (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001).
 *
 * The fail-closed ordering between the broker and the Worker is a security
 * property, so it is asserted here rather than left as prose in a runbook. As
 * with the container-policy suite, this checks SEMANTICS: directive values, not
 * formatting, so the units can be reordered or re-commented freely.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEPLOY = join(REPO_ROOT, "deploy", "systemd");

const BROKER_UNIT = join(DEPLOY, "videofetch-r2-broker.service");
const WORKER_UNIT = join(DEPLOY, "videofetch-worker.service");
const BROKER_ENV_TEMPLATE = join(DEPLOY, "r2-broker.env.example");

/** Strips comments and joins line continuations into logical directives. */
function parseUnit(source: string): string[] {
  const logical: string[] = [];
  let buffer = "";
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
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
  return logical;
}

/** All values assigned to a directive, comments excluded. */
function values(directives: string[], key: string): string[] {
  return directives
    .filter((d) => d.toLowerCase().startsWith(`${key.toLowerCase()}=`))
    .map((d) => d.slice(key.length + 1).trim());
}

/**
 * Logical directives grouped by the [Section] they appear under.
 *
 * systemd resolves several directives by section, and silently ignores a key
 * placed in the wrong one. Presence alone is therefore not evidence a
 * directive is in force (PHASE-8B-FIRST-DEPLOYMENT-DEFECTS-001).
 */
function parseSections(source: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const directive of parseUnit(source)) {
    const header = /^\[(.+)\]$/.exec(directive);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === "") continue;
    sections.get(current)!.push(directive);
  }
  return sections;
}

describe("trusted broker deployment policy", () => {
  let brokerUnit: string[];
  let brokerSections: Map<string, string[]>;
  let workerUnit: string[];
  let brokerSource: string;
  let workerSource: string;
  let envTemplate: string;

  before(async () => {
    brokerSource = await readFile(BROKER_UNIT, "utf8");
    workerSource = await readFile(WORKER_UNIT, "utf8");
    envTemplate = await readFile(BROKER_ENV_TEMPLATE, "utf8");
    brokerUnit = parseUnit(brokerSource);
    brokerSections = parseSections(brokerSource);
    workerUnit = parseUnit(workerSource);
  });

  describe("fail-closed ordering", () => {
    it("refuses to start the Worker without the broker", () => {
      assert.ok(
        values(workerUnit, "Requires").includes("videofetch-r2-broker.service"),
        "Requires= must name the broker unit",
      );
      assert.ok(
        values(workerUnit, "After").includes("videofetch-r2-broker.service"),
        "After= must name the broker unit, so the socket exists first",
      );
    });

    it("stops the Worker when the broker goes away", () => {
      assert.ok(
        values(workerUnit, "BindsTo").includes("videofetch-r2-broker.service"),
        "BindsTo= is what turns a later broker failure into a Worker stop " +
          "rather than a Worker running without a credential source",
      );
    });

    it("does NOT make the broker depend on the Worker", () => {
      // The asymmetry is the point: the broker may run without the Worker, but
      // never the reverse.
      for (const key of ["Requires", "BindsTo", "After", "Wants", "PartOf"]) {
        for (const value of values(brokerUnit, key)) {
          assert.equal(
            value.includes("videofetch-worker"),
            false,
            `the broker's ${key}= must not reference the Worker unit`,
          );
        }
      }
    });

    it("gives up rather than restart-looping past a configuration failure", () => {
      // A malformed configuration is startup-fatal. Restarting forever would
      // hide it AND leave the Worker flapping alongside.
      assert.deepEqual(values(brokerUnit, "Restart"), ["on-failure"]);

      // The rate limit must be declared in [Unit], and asserting mere presence
      // is not enough. systemd 255 parses StartLimitIntervalSec and
      // StartLimitBurst from [Unit] ONLY; in [Service] it logs "Unknown key
      // name ... ignoring" and applies no limit at all — leaving exactly the
      // restart loop this test exists to prevent, while a presence-only
      // assertion still passed (PHASE-8B-FIRST-DEPLOYMENT-DEFECTS-001).
      const unitSection = brokerSections.get("Unit") ?? [];
      const serviceSection = brokerSections.get("Service") ?? [];
      for (const key of ["StartLimitIntervalSec", "StartLimitBurst"]) {
        assert.ok(
          values(unitSection, key).length > 0,
          `${key} must be declared in [Unit], where systemd reads it`,
        );
        assert.equal(
          values(serviceSection, key).length,
          0,
          `${key} in [Service] is ignored by systemd, so the limit would not apply`,
        );
      }
    });
  });

  describe("parent credential custody", () => {
    it("supplies the parent credential ONLY through the broker's EnvironmentFile", () => {
      assert.ok(
        values(brokerUnit, "EnvironmentFile").length > 0,
        "the parent credential arrives via EnvironmentFile",
      );

      // Never through Environment= (visible in `systemctl show`) and never
      // through argv (world-readable via /proc).
      for (const inline of values(brokerUnit, "Environment")) {
        assert.equal(
          /R2_BROKER_PARENT_/.test(inline),
          false,
          "the parent credential must not be an inline Environment= value",
        );
      }
      for (const exec of values(brokerUnit, "ExecStart")) {
        assert.equal(
          /R2_BROKER_PARENT_|SECRET|secret/.test(exec),
          false,
          "the parent credential must never appear in argv",
        );
      }
    });

    it("never gives the Worker unit any R2 credential", () => {
      const workerExecutable = workerUnit.join("\n");
      for (const forbidden of [
        "R2_BROKER_PARENT_ACCESS_KEY_ID",
        "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
        "R2_WRITER_ACCESS_KEY_ID",
        "R2_WRITER_SECRET_ACCESS_KEY",
        "R2_WRITER_SESSION_TOKEN",
        "R2_SIGNER_ACCESS_KEY_ID",
        "R2_SIGNER_SECRET_ACCESS_KEY",
      ]) {
        assert.equal(
          workerExecutable.includes(forbidden),
          false,
          `the Worker unit must never supply ${forbidden}`,
        );
      }
    });

    it("ships an environment template that contains no real secret", () => {
      // Every assignment in the template must be empty. No credential is
      // provisioned in this repository.
      for (const line of envTemplate.split("\n")) {
        if (/^\s*#/.test(line) || line.trim() === "") continue;
        assert.match(line, /^[A-Z0-9_]+=$/, `template value must be empty: ${line}`);
      }
      assert.match(envTemplate, /R2_BROKER_PARENT_SECRET_ACCESS_KEY=/);
    });
  });

  describe("boundary shape", () => {
    it("mounts the broker socket directory READ-ONLY into the Worker container", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      assert.match(
        exec,
        /--volume\s+\/run\/videofetch-r2-broker:\/run\/videofetch-r2-broker:ro\b/,
        "a read-only mount is what prevents the container replacing the socket",
      );
    });

    it("grants the broker group by NUMERIC gid, never by name", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");

      // Docker resolves a --group-add NAME inside the IMAGE, and the Worker
      // image defines no videofetch-broker group. A named group here would
      // fail or silently resolve to something unintended.
      assert.doesNotMatch(
        exec,
        /--group-add\s+videofetch-broker\b/,
        "a host-only group NAME is not resolvable inside the image",
      );
      assert.match(
        exec,
        /--group-add\s+\$\{VIDEOFETCH_BROKER_GID\}/,
        "the supplementary group must be supplied as a numeric gid",
      );

      // The gid is resolved on the host at install time, not hard-coded.
      assert.ok(
        values(workerUnit, "EnvironmentFile").some((f) => f.includes("broker-gid.env")),
        "the gid arrives from a generated deployment environment file",
      );
      assert.doesNotMatch(
        exec,
        /--group-add\s+[0-9]+/,
        "the gid must not be hard-coded to a guessed value",
      );
    });

    it("fails closed if the configured gid does not own the socket", () => {
      const pre = values(workerUnit, "ExecStartPre").join("\n");
      assert.match(
        pre,
        /vf-r2-broker-gid-verify[^\n]*\$\{VIDEOFETCH_BROKER_GID\}/,
        "a pre-start gate must assert the gid against the socket's real group",
      );
      // The gate must NOT be prefixed with '-', which would ignore its failure.
      assert.ok(
        values(workerUnit, "ExecStartPre").some(
          (v) => v.includes("vf-r2-broker-gid-verify") && !v.trimStart().startsWith("-"),
        ),
        "the gid gate's failure must be fatal, not ignored",
      );
    });

    it("does NOT mount host account databases into the media container", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      for (const forbidden of ["/etc/passwd", "/etc/group", "/etc/shadow"]) {
        assert.equal(
          exec.includes(forbidden),
          false,
          `${forbidden} must never be mounted into the media container`,
        );
      }
    });

    it("passes the Worker a socket PATH and nothing credential-shaped", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      assert.match(exec, /R2_BROKER_SOCKET_PATH=\/run\/videofetch-r2-broker\/broker\.sock/);
    });

    it("keeps the Worker container unprivileged", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      assert.match(exec, /--cap-drop=ALL\b/);
      assert.match(exec, /--security-opt\s+no-new-privileges\b/);
      assert.doesNotMatch(exec, /NET_ADMIN/i);
      assert.doesNotMatch(exec, /SYS_ADMIN/i);
      assert.doesNotMatch(exec, /--privileged\b/);
      assert.doesNotMatch(exec, /docker\.sock/);
      assert.doesNotMatch(exec, /--network\s+host\b/);
    });

    it("denies the broker a network it does not need", () => {
      // Local signing makes no API call, so the broker is confined to AF_UNIX.
      assert.deepEqual(values(brokerUnit, "PrivateNetwork"), ["yes"]);
      assert.deepEqual(values(brokerUnit, "RestrictAddressFamilies"), ["AF_UNIX"]);
      assert.deepEqual(values(brokerUnit, "CapabilityBoundingSet"), [""]);
      assert.deepEqual(values(brokerUnit, "NoNewPrivileges"), ["yes"]);
    });

    it("never combines MemoryDenyWriteExecute with runtime type stripping", () => {
      // MEASURED on the target VM (Ubuntu 24.04.4, Node 22.23.2, aarch64):
      //
      //   W^X + JIT       -> V8 fatal in OS::SetPermissions, status=5/TRAP.
      //   W^X + --jitless -> ERR_WEBASSEMBLY_NOT_SUPPORTED, because Node's
      //                      native type stripper is a WASM module and
      //                      --jitless disables WebAssembly.
      //
      // So while the broker runs TypeScript directly, MemoryDenyWriteExecute
      // is unusable in BOTH configurations. A unit that cannot start is not a
      // security control, so the pairing must never be shipped.
      const wx = values(brokerUnit, "MemoryDenyWriteExecute");
      const exec = values(brokerUnit, "ExecStart").join("\n");
      const stripsTypes = /--experimental-strip-types/.test(exec);
      const jitless = /(^|\s)--jitless(\s|$)/.test(exec);

      if (wx.includes("yes")) {
        assert.equal(
          stripsTypes,
          false,
          "MemoryDenyWriteExecute=yes cannot coexist with --experimental-strip-types: " +
            "with the JIT the broker SIGTRAPs, and --jitless removes the WebAssembly " +
            "the type stripper needs",
        );
        assert.ok(jitless, "MemoryDenyWriteExecute=yes additionally requires --jitless");
      }
    });

    it("documents why MemoryDenyWriteExecute is absent, rather than dropping it silently", () => {
      // The omission is a measured decision. Losing that reasoning would invite
      // someone to "harden" the unit back into a state that cannot boot.
      if (!values(brokerUnit, "MemoryDenyWriteExecute").includes("yes")) {
        assert.match(
          brokerSource,
          /MemoryDenyWriteExecute is deliberately NOT set/,
          "the unit must explain the omission",
        );
        assert.match(brokerSource, /TRAP/, "and cite the measured failure");
        assert.match(brokerSource, /ERR_WEBASSEMBLY_NOT_SUPPORTED/);
      }
    });

    it("retains the confinement that actually contains the broker", () => {
      // Whatever happens to W^X, these are the directives doing the real work.
      assert.deepEqual(values(brokerUnit, "PrivateNetwork"), ["yes"]);
      assert.deepEqual(values(brokerUnit, "RestrictAddressFamilies"), ["AF_UNIX"]);
      assert.deepEqual(values(brokerUnit, "CapabilityBoundingSet"), [""]);
      assert.deepEqual(values(brokerUnit, "NoNewPrivileges"), ["yes"]);
      assert.deepEqual(values(brokerUnit, "ProtectSystem"), ["strict"]);
      assert.deepEqual(values(brokerUnit, "ProtectHome"), ["yes"]);
      assert.deepEqual(values(brokerUnit, "RestrictSUIDSGID"), ["yes"]);
      assert.deepEqual(values(brokerUnit, "RestrictNamespaces"), ["yes"]);
    });

    it("runs a Node new enough for native type stripping", () => {
      const exec = values(brokerUnit, "ExecStart").join("\n");
      assert.match(exec, /--experimental-strip-types/);
      // The distro's packaged Node 18 cannot strip types; the unit must not
      // silently depend on whatever /usr/bin/node happens to be.
      assert.doesNotMatch(
        exec,
        /^\/usr\/bin\/node(\s|$)/m,
        "the broker must name an explicit Node >= 22.6 runtime",
      );
    });

    it("runs the broker as a dedicated non-root user", () => {
      const user = values(brokerUnit, "User");
      assert.equal(user.length, 1);
      assert.notEqual(user[0], "root");
      assert.equal(user[0], "videofetch-broker");
    });

    it("launches the broker's own entry point", () => {
      assert.match(values(brokerUnit, "ExecStart").join("\n"), /src\/broker\/r2\/main\.ts/);
    });

    it("keeps yt-dlp disabled in the Worker unit", () => {
      const workerExecutable = workerUnit.join("\n");
      for (const truthy of ["true", "1", "yes"]) {
        assert.doesNotMatch(
          workerExecutable,
          new RegExp(`YTDLP_NETWORK_ISOLATED\\s*=\\s*["']?${truthy}["']?(\\s|$)`, "i"),
          `YTDLP_NETWORK_ISOLATED must never be set to ${truthy}`,
        );
      }
    });
  });

  it("documents that nothing has been provisioned", () => {
    for (const source of [brokerSource, workerSource, envTemplate]) {
      assert.match(
        source,
        /NOTHING HAS BEEN PROVISIONED|Nothing here has been provisioned|no secret in this repository/i,
        "each artefact states its unprovisioned status",
      );
    }
  });
});
