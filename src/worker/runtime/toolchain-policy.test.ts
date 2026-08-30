import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Static package-manager policy guard (NPM-LOCKFILE-RECONCILIATION-001).
 *
 * The broker host installs its production dependency tree with `npm ci`. That
 * command is only reproducible if the repository names ONE package manager,
 * exactly. Before this guard existed the deployment silently inherited
 * whichever npm shipped with Node, and Node v22.23.2 bundles npm 10.9.8 —
 * which eagerly materialises `lru-cache@11`, an OPTIONAL PEER dependency of
 * the dev-only `unstorage` under `nitro`, and then rejects the committed
 * lockfile for not containing the entry it invented:
 *
 *     npm ci can only install packages when your package.json and
 *     package-lock.json are in sync.
 *     Missing: lru-cache@11.5.2 from lock file
 *
 * npm >= 11 does not install unrequested optional peers, so it accepts the
 * committed lockfile unmodified. The pin is therefore a correctness
 * requirement, not a preference, and these assertions check SEMANTICS — the
 * resolved values — so the docs may be reworded freely.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The single source of truth for the deployment toolchain. */
const NODE_VERSION = "22.23.2";
const NPM_VERSION = "11.19.1";
const INSTALL_COMMAND = "npm ci --omit=dev --ignore-scripts --no-audit --no-fund";

/**
 * npm 10 and earlier install optional peer dependencies that nothing requires
 * and then fail `npm ci` against a lockfile written by a newer npm. 11 is the
 * first major that round-trips this repository's lockfile unchanged.
 */
const MINIMUM_NPM_MAJOR = 11;

/** Exactly `npm@<major>.<minor>.<patch>` — no range, no tag, no build suffix. */
const EXACT_NPM_PIN = /^npm@(\d+)\.(\d+)\.(\d+)$/;

const DEPLOY_README = join(REPO_ROOT, "deploy", "README.md");
const RUNBOOK = join(REPO_ROOT, "docs", "architecture", "worker-deployment-runbook.md");

describe("deployment toolchain policy", () => {
  let pkg: { packageManager?: unknown };
  let lock: { lockfileVersion?: unknown };
  let deployReadme: string;
  let runbook: string;

  before(async () => {
    pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
    lock = JSON.parse(await readFile(join(REPO_ROOT, "package-lock.json"), "utf8"));
    deployReadme = await readFile(DEPLOY_README, "utf8");
    runbook = await readFile(RUNBOOK, "utf8");
  });

  describe("package manager pin", () => {
    it("declares a packageManager", () => {
      assert.equal(
        typeof pkg.packageManager,
        "string",
        "package.json must declare packageManager, or the deployment silently " +
          "inherits whichever npm ships with Node",
      );
    });

    it("pins an exact version, never a range or tag", () => {
      const pin = String(pkg.packageManager);
      assert.match(
        pin,
        EXACT_NPM_PIN,
        `packageManager must be an exact npm@X.Y.Z pin, got ${pin}. ` +
          "A range (npm@^11), a bare major (npm@11) or a tag (npm@latest) " +
          "reintroduces the non-reproducible install this pin exists to stop",
      );
    });

    it("pins the npm the lockfile was reconciled against", () => {
      assert.equal(String(pkg.packageManager), `npm@${NPM_VERSION}`);
    });

    it("never regresses to an npm that breaks this lockfile", () => {
      const match = EXACT_NPM_PIN.exec(String(pkg.packageManager));
      assert.ok(match, "packageManager must parse as an exact npm pin");
      assert.ok(
        Number(match[1]) >= MINIMUM_NPM_MAJOR,
        `npm ${match[1]} installs unrequested optional peer dependencies and ` +
          `then rejects this lockfile; npm >= ${MINIMUM_NPM_MAJOR} is required`,
      );
    });
  });

  describe("lockfile", () => {
    it("stays at lockfileVersion 3", () => {
      assert.equal(
        lock.lockfileVersion,
        3,
        "a lockfileVersion change is a package-manager contract change and " +
          "must be a deliberate, reviewed decision",
      );
    });
  });

  describe("documented toolchain", () => {
    it("names the exact npm version in the deployment docs", () => {
      for (const [name, source] of [
        ["deploy/README.md", deployReadme],
        ["docs/architecture/worker-deployment-runbook.md", runbook],
      ] as const) {
        assert.ok(
          source.includes(`npm@${NPM_VERSION}`) || source.includes(`npm ${NPM_VERSION}`),
          `${name} must document the exact pinned npm (${NPM_VERSION}) so an ` +
            "operator provisions the same package manager the lockfile expects",
        );
      }
    });

    it("names the exact broker Node version in the deployment docs", () => {
      for (const [name, source] of [
        ["deploy/README.md", deployReadme],
        ["docs/architecture/worker-deployment-runbook.md", runbook],
      ] as const) {
        assert.ok(
          source.includes(NODE_VERSION),
          `${name} must document the exact broker Node version (${NODE_VERSION})`,
        );
      }
    });

    it("documents the production install command", () => {
      for (const [name, source] of [
        ["deploy/README.md", deployReadme],
        ["docs/architecture/worker-deployment-runbook.md", runbook],
      ] as const) {
        assert.ok(
          source.includes(INSTALL_COMMAND),
          `${name} must document the exact production install command, so the ` +
            "dev tree is never installed on the broker host",
        );
      }
    });
  });
});
