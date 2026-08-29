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

describe("trusted broker deployment policy", () => {
  let brokerUnit: string[];
  let workerUnit: string[];
  let brokerSource: string;
  let workerSource: string;
  let envTemplate: string;

  before(async () => {
    brokerSource = await readFile(BROKER_UNIT, "utf8");
    workerSource = await readFile(WORKER_UNIT, "utf8");
    envTemplate = await readFile(BROKER_ENV_TEMPLATE, "utf8");
    brokerUnit = parseUnit(brokerSource);
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
      assert.ok(values(brokerUnit, "StartLimitBurst").length > 0, "a start limit is declared");
      assert.deepEqual(values(brokerUnit, "Restart"), ["on-failure"]);
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
      assert.match(exec, /--group-add\s+videofetch-broker\b/, "group membership permits connect(2)");
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
