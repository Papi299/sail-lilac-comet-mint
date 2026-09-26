import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { WORKER_HEALTH_PATH } from "../../shared/worker/constants.ts";
import {
  LIVENESS_HOST,
  LIVENESS_PATH,
  LIVENESS_EXPECTED_STATUS,
} from "../../../deploy/bin/vf-worker-health-request.mjs";

/**
 * Static and behavioural policy guard for the EXTERNAL Worker liveness probe
 * (WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001; runtime identity
 * corrected by WORKER-LIVENESS-STATIC-USER-CORRECTION-001).
 *
 * Two halves, in the style of the safe-egress suite:
 *
 *   STATIC       — asserts the SEMANTICS of the probe, its units and the
 *                  artefacts it must NOT have changed. Comments are stripped
 *                  first, so re-commenting or reordering cannot fail these;
 *                  only a policy regression can. Several of these files
 *                  deliberately NAME the thing they refuse to do, and a naive
 *                  substring search would read those explanations as the
 *                  behaviour they warn against.
 *
 *   BEHAVIOURAL  — actually RUNS the shipped probe against a stub `systemctl`
 *                  and real loopback listeners, because a probe that greps for
 *                  the right states and exits 0 regardless would pass every
 *                  static test ever written.
 *
 * NOTHING HERE TOUCHES THE LIMA VM, the real Worker, Cloudflare or the network.
 * Every listener is bound to 127.0.0.1 on an ephemeral port inside this test
 * process; `systemctl`, `docker` and `nsenter` are stubs that record what they
 * were asked to do; no container runtime, namespace, root privilege or systemd
 * is used or required.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEPLOY = join(REPO_ROOT, "deploy");
const SYSTEMD = join(DEPLOY, "systemd");
const BIN = join(DEPLOY, "bin");

const PROBE_SCRIPT = join(BIN, "vf-worker-liveness-probe");
const REQUEST_MODULE = join(BIN, "vf-worker-health-request.mjs");
const EGRESS_LIB = join(BIN, "vf-egress-lib.sh");

const LIVENESS_SERVICE = join(SYSTEMD, "videofetch-worker-liveness.service");
const LIVENESS_TIMER = join(SYSTEMD, "videofetch-worker-liveness.timer");
const WORKER_UNIT = join(SYSTEMD, "videofetch-worker.service");
const NETNS_UNIT = join(SYSTEMD, "videofetch-media-netns.service");
const EGRESS_ENV_TEMPLATE = join(SYSTEMD, "media-egress.env.example");
const DOCKERFILE = join(REPO_ROOT, "Dockerfile.worker");
const DEPLOY_README = join(DEPLOY, "README.md");

/** The dedicated static service account the probe runs as. */
const LIVENESS_ACCOUNT = "videofetch-liveness";

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

/** Drops whole-line `#` comments. Prose must neither satisfy nor break a claim. */
function executableLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** All values assigned to a directive, comments excluded. */
function values(directives: string[], key: string): string[] {
  return directives
    .filter((d) => d.toLowerCase().startsWith(`${key.toLowerCase()}=`))
    .map((d) => d.slice(key.length + 1).trim());
}

/** Every whitespace-separated token of every value of a directive. */
function tokens(directives: string[], key: string): string[] {
  return values(directives, key).flatMap((v) => v.split(/\s+/).filter(Boolean));
}

/**
 * The probe's identity contract, as a function so it can be applied both to
 * the shipped unit and to deliberately regressed copies of it. Returns every
 * violation; an empty list means the unit complies.
 */
function staticIdentityViolations(directives: string[]): string[] {
  const violations: string[] = [];
  const dynamic = values(directives, "DynamicUser");
  if (dynamic.length > 0) {
    violations.push(
      `DynamicUser=${dynamic.join(",")} is set — on the Production VM that identity could not query systemd`,
    );
  }
  const users = values(directives, "User");
  const groups = values(directives, "Group");
  const supplementary = tokens(directives, "SupplementaryGroups");
  if (users.length !== 1 || users[0] !== LIVENESS_ACCOUNT) {
    violations.push(`User= must be exactly ${LIVENESS_ACCOUNT}, got [${users.join(", ")}]`);
  }
  if (groups.length !== 1 || groups[0] !== LIVENESS_ACCOUNT) {
    violations.push(`Group= must be exactly ${LIVENESS_ACCOUNT}, got [${groups.join(", ")}]`);
  }
  if (values(directives, "SupplementaryGroups").length > 0) {
    violations.push(`SupplementaryGroups= must not be set, got [${supplementary.join(", ")}]`);
  }
  for (const forbidden of ["root", "0", "nobody", "65534", "nogroup", "videofetch-broker", "docker"]) {
    if ([...users, ...groups, ...supplementary].includes(forbidden)) {
      violations.push(`${forbidden} must never be part of the probe's identity`);
    }
  }
  return violations;
}

/** Joins backslash continuations, so a wrapped shell command is matched as one line. */
function logicalCommands(markdown: string): string[] {
  return markdown
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim());
}

describe("external Worker liveness probe — source contract", () => {
  let probe: string;
  let probeExec: string;
  let requestModule: string;
  let requestExec: string;

  before(async () => {
    probe = await readFile(PROBE_SCRIPT, "utf8");
    probeExec = executableLines(probe);
    requestModule = await readFile(REQUEST_MODULE, "utf8");
    // The request module is JavaScript, so `//` line comments are what hide
    // prose here, not `#`.
    requestExec = requestModule
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
  });

  it("targets the Worker's real health path, and agrees with the application constant", () => {
    // The probe module cannot import the TypeScript constant — it is executed by
    // the bare host Node with no loader — so the two are kept in step HERE, the
    // same way container-policy.test.ts keeps YTDLP_RUNTIME and the Dockerfile
    // in step.
    assert.equal(LIVENESS_PATH, WORKER_HEALTH_PATH);
    assert.equal(LIVENESS_PATH, "/v1/healthz");
  });

  it("expects the health state the Worker's HTTP server actually reports", async () => {
    const server = await readFile(
      join(REPO_ROOT, "src", "worker", "http", "server.server.ts"),
      "utf8",
    );
    // The Worker answers the health route with exactly this body; if that ever
    // changes, this assertion is where the probe finds out.
    assert.match(server, /sendJson\(res,\s*200,\s*\{\s*status:\s*"ok"\s*\}\)/);
    assert.equal(LIVENESS_EXPECTED_STATUS, "ok");
  });

  it("dials loopback by LITERAL address, never a resolvable name", () => {
    assert.equal(LIVENESS_HOST, "127.0.0.1");
    // `localhost` can resolve to ::1, to both families in an unspecified order,
    // or anywhere a creative /etc/hosts sends it. The published ingress is
    // 127.0.0.1:<port> exactly.
    assert.doesNotMatch(requestExec, /\blocalhost\b/);
    assert.doesNotMatch(probeExec, /\blocalhost\b/);
  });

  it("consumes the declared port from its environment and validates it fail-closed", () => {
    // PID 1 delivers VIDEOFETCH_WORKER_PORT from media-egress.env (see the
    // wiring suite). The probe validates it with the SAME rule that gates the
    // namespace holder, sourced from the shared library.
    assert.match(probeExec, /\$\{VIDEOFETCH_WORKER_PORT-\}/, "the delivered port is used");
    assert.match(probeExec, /VF_EGRESS_LIB/, "the shared validator is sourced");
    assert.match(probeExec, /vf_validate_port/, "and it is validated fail-closed");
  });

  it("NEVER traverses the root-only /etc/videofetch directory itself", () => {
    // REVIEW-CORRECTION-001, finding 1. /etc/videofetch is root-owned 0700 — it
    // also holds broker credentials — and the probe runs as an unprivileged
    // account that cannot traverse it. The first revision read media-egress.env directly
    // through vf_config_load, which could never have worked when deployed.
    // Operator diagnostics may NAME the file so a fault is actionable. Only a
    // pure quoted-string `echo` to stdout/stderr is exempt; an echo that
    // redirects into a path is still an access and is still checked.
    const diagnostic = /^\s*echo\s+"[^"]*"\s*(>&2)?\s*$/;
    const accessing = probeExec
      .split("\n")
      .filter((line) => !diagnostic.test(line))
      .join("\n");
    for (const forbidden of [
      /\/etc\/videofetch/,
      /\bvf_config_load\b/,
      /\bvf_config_read\b/,
      /\bVF_CONFIG_FILE\b/,
      /media-egress\.env/,
      /\bvf_die\b/,
    ]) {
      assert.doesNotMatch(accessing, forbidden, `the probe must not use ${forbidden}`);
    }
  });

  it("routes EVERY exit through one OUTCOME record, with a backstop for the rest", () => {
    // REVIEW-CORRECTION-001: the first revision promised one OUTCOME line on
    // every path while calling a shared helper that could exit without one.
    assert.match(probeExec, /trap vf_on_exit EXIT/, "an EXIT backstop is installed");
    assert.match(probeExec, /OUTCOME=internal-error/, "and reports unexpected exits");
    // Every literal `exit` lives inside verdict() or the backstop.
    const exits = probeExec
      .split("\n")
      .filter((line) => /(^|[\s;])exit(\s|$)/.test(line));
    assert.deepEqual(
      exits.map((line) => line.trim()),
      ['exit "$code"', "exit 2"],
      "no exit may bypass verdict() and the EXIT backstop",
    );
  });

  it("introduces no second Worker-port setting, and hard-codes no port", () => {
    // 8080 is the Worker's in-image default, but the deployment's ingress port is
    // configuration. A literal here would silently diverge from the port the
    // namespace holder publishes.
    assert.doesNotMatch(probeExec, /\b8080\b/);
    assert.doesNotMatch(requestExec, /\b8080\b/);
    for (const invented of ["LIVENESS_PORT", "PROBE_PORT", "HEALTH_PORT", "WORKER_HEALTH_PORT"]) {
      assert.doesNotMatch(
        probeExec,
        new RegExp(`\\b${invented}\\s*=`),
        `${invented} would be a second authoritative port setting`,
      );
    }
  });

  it("neither joins the media namespace nor talks to a container runtime", () => {
    for (const forbidden of [/\bnsenter\b/, /\bdocker\b/, /docker\s+exec/, /\.sock\b/]) {
      assert.doesNotMatch(probeExec, forbidden, `the probe must not use ${forbidden}`);
      assert.doesNotMatch(requestExec, forbidden, `the request module must not use ${forbidden}`);
    }
    // The namespace-entry helpers exist in the shared library; the probe must not
    // reach for them.
    for (const forbidden of [/vf_in_ns/, /vf_netns_pid/, /VF_NSENTER/, /VF_DOCKER/]) {
      assert.doesNotMatch(probeExec, forbidden);
    }
  });

  it("never repairs: no start, stop, restart, reload, enable or kill", () => {
    // THE CRITICAL PROHIBITION. An observer that restarts things is a supervisor,
    // and the Worker already has one — systemd, through its own Restart= and
    // BindsTo= semantics, which this probe must leave alone.
    for (const verb of [
      "start",
      "stop",
      "restart",
      "try-restart",
      "reload",
      "reload-or-restart",
      "kill",
      "enable",
      "disable",
      "mask",
      "unmask",
      "reset-failed",
      "daemon-reload",
    ]) {
      assert.doesNotMatch(
        probeExec,
        new RegExp(`systemctl[^\\n]*\\b${verb}\\b|\\$SYSTEMCTL[^\\n]*\\b${verb}\\b|\\$\\{SYSTEMCTL\\}[^\\n]*\\b${verb}\\b`),
        `the probe must never invoke systemctl ${verb}`,
      );
    }
    // Only read-only predicates are permitted.
    assert.match(probeExec, /\$SYSTEMCTL"?\s+show\b/, "state is READ with `show`");
    assert.match(probeExec, /\$SYSTEMCTL"?\s+is-failed\b/, "and with `is-failed`");
  });

  it("mutates no firewall, namespace or routing state", () => {
    for (const forbidden of [/\bnft\b/, /\biptables\b/, /\bip6tables\b/, /\bnftables\b/, /\bufw\b/, /\bip\s+route\b/, /\bip\s+rule\b/, /\blimactl\b/]) {
      assert.doesNotMatch(probeExec, forbidden, `the probe must not touch ${forbidden}`);
      assert.doesNotMatch(requestExec, forbidden);
    }
  });

  it("is stateless: no counter, spool or history that could replay an idle VM", () => {
    // "No catch-up mechanism that interprets time spent powered off as
    // accumulated liveness failures" is guaranteed on two sides: the timer's
    // Persistent=false, and the probe keeping no state to accumulate INTO.
    for (const forbidden of [/\bmktemp\b/, /\btee\b/, />>\s*["']?\/var/, />\s*["']?\/var/, /\bStateDirectory\b/]) {
      assert.doesNotMatch(probeExec, forbidden, `the probe must not persist state via ${forbidden}`);
    }
  });

  it("reuses the already-required host runtime and installs no liveness client", () => {
    // §6: no new host dependency. The pinned host Node is install-order step 0 —
    // the R2 broker cannot run without it — so the probe adds nothing.
    assert.match(probeExec, /\/opt\/videofetch\/node\/bin\/node/, "the pinned host Node is the default");
    for (const forbidden of [/\bcurl\b/, /\bwget\b/, /\bhttpie\b/, /\bapt-get\b/, /\bapt\s+install\b/, /\bnc\b/, /\bsocat\b/]) {
      assert.doesNotMatch(probeExec, forbidden, `the probe must not depend on ${forbidden}`);
    }
  });

  it("bounds the request with ONE total deadline and a body cap", () => {
    assert.match(requestExec, /setTimeout\(/, "a total deadline exists");
    assert.match(requestExec, /LIVENESS_MAX_BODY_BYTES/, "the body is capped");
    // A per-socket inactivity timeout can be held open forever by a peer that
    // dribbles one byte before each expiry.
    assert.doesNotMatch(requestExec, /req\.setTimeout\(/);
  });

  it("sends no credential and no VideoFetch HMAC header", () => {
    for (const forbidden of [/x-videofetch-/i, /authorization/i, /\bcookie\b/i, /CF-Access-Client/i, /WORKER_CONTROL_SECRET/, /createHmac/]) {
      assert.doesNotMatch(requestExec, forbidden, `the loopback probe must not send ${forbidden}`);
      assert.doesNotMatch(probeExec, forbidden);
    }
  });

  it("does not follow a redirect, which would let something else answer for the Worker", () => {
    // node:http does not follow redirects, and nothing here adds it. A 3xx is a
    // non-200 and therefore a failure.
    assert.doesNotMatch(requestExec, /follow(-|_)?redirect/i);
    assert.match(requestExec, /status\s*!==\s*200/, "only 200 passes");
  });
});

describe("liveness probe deployment wiring", () => {
  let service: string;
  let serviceDirectives: string[];
  let serviceExec: string;
  let timer: string;
  let timerDirectives: string[];
  let timerExec: string;
  let workerUnitExec: string;
  let netnsUnitExec: string;

  before(async () => {
    service = await readFile(LIVENESS_SERVICE, "utf8");
    serviceDirectives = parseUnit(service);
    serviceExec = executableLines(service);
    timer = await readFile(LIVENESS_TIMER, "utf8");
    timerDirectives = parseUnit(timer);
    timerExec = executableLines(timer);
    workerUnitExec = executableLines(await readFile(WORKER_UNIT, "utf8"));
    netnsUnitExec = executableLines(await readFile(NETNS_UNIT, "utf8"));
  });

  it("runs the probe as the unit's own work, and nothing else", () => {
    const execStart = values(serviceDirectives, "ExecStart");
    assert.equal(execStart.length, 1, "exactly one ExecStart");
    assert.match(execStart[0]!, /vf-worker-liveness-probe/);
    assert.equal(values(serviceDirectives, "Type")[0], "oneshot");
  });

  it("CANNOT pull the Worker into the active state", () => {
    // The single most important property of this unit. `After=` is ordering and
    // activates nothing; every activating dependency kind must be absent.
    for (const key of ["Requires", "Requisite", "Wants", "BindsTo", "PartOf", "Upholds", "RequiresMountsFor", "JoinsNamespaceOf"]) {
      const referencing = tokens(serviceDirectives, key).filter((t) => /videofetch-worker\.service/.test(t));
      assert.deepEqual(
        referencing,
        [],
        `${key}= must not reference videofetch-worker.service — the probe must never start it`,
      );
    }
    // And the same for the timer.
    for (const key of ["Requires", "Requisite", "Wants", "BindsTo", "PartOf", "Upholds"]) {
      const referencing = tokens(timerDirectives, key).filter((t) => /videofetch-worker\.service/.test(t));
      assert.deepEqual(referencing, [], `the timer's ${key}= must not reference the Worker`);
    }
  });

  it("is triggered by the timer alone, never enabled as a boot one-shot", () => {
    // No [Install] in the service: enabling it would run the probe once at boot
    // with no cadence, and enabling both would run it twice.
    assert.doesNotMatch(serviceExec, /^\s*\[Install\]/m, "the probe service has no [Install]");
    assert.doesNotMatch(serviceExec, /WantedBy=/);
    assert.equal(values(timerDirectives, "WantedBy")[0], "timers.target");
    assert.equal(values(timerDirectives, "Unit")[0], "videofetch-worker-liveness.service");
  });

  it("does NOT replay missed runs after an intentionally stopped VM", () => {
    // `Persistent=true` would fire a catch-up run for every elapsation the VM
    // missed while powered off, turning ordinary Product idle into a burst of
    // liveness noise. Stated explicitly rather than left to the default.
    assert.equal(values(timerDirectives, "Persistent")[0], "false");
  });

  it("has a bounded, documented cadence and creates no 24/7 requirement", () => {
    const onBoot = values(timerDirectives, "OnBootSec")[0];
    const onActive = values(timerDirectives, "OnUnitActiveSec")[0];
    assert.ok(onBoot, "a first-tick delay is declared");
    assert.ok(onActive, "a repeat interval is declared");
    // Uptime-relative triggers only. A calendar trigger would be the wrong shape
    // for a VM that is deliberately off most of the time.
    assert.deepEqual(values(timerDirectives, "OnCalendar"), []);
    // Nothing is kept running between ticks.
    assert.deepEqual(values(serviceDirectives, "RemainAfterExit"), []);
    assert.equal(values(serviceDirectives, "Restart")[0], "no");
  });

  it("stays useful after repeated failures instead of latching itself off", () => {
    // systemd's default start-rate limiting would eventually refuse to start the
    // unit at all after consecutive failures, and the deployment would silently
    // stop being observed — the one failure mode an observability mechanism
    // cannot have.
    assert.equal(values(serviceDirectives, "StartLimitIntervalSec")[0], "0");
  });

  it("holds no capability and cannot enter a namespace", () => {
    assert.equal(values(serviceDirectives, "CapabilityBoundingSet")[0], "");
    assert.equal(values(serviceDirectives, "AmbientCapabilities")[0], "");
    assert.equal(values(serviceDirectives, "NoNewPrivileges")[0], "yes");
    assert.equal(values(serviceDirectives, "RestrictNamespaces")[0], "yes");
    for (const forbidden of [/NET_ADMIN/, /SYS_ADMIN/, /--privileged/, /docker\.sock/]) {
      assert.doesNotMatch(serviceExec, forbidden);
    }
  });

  it("does not sandbox the pinned Node out of existence", async () => {
    // The HTTP request runs on the pinned host Node. MemoryDenyWriteExecute
    // forbids V8's JIT from making written pages executable, so Node would fail
    // at startup and every tick would read as "unhealthy" — a probe that always
    // fails is indistinguishable from no probe. The broker, which runs the same
    // binary on the same host in Production, omits it for the same reason.
    assert.deepEqual(values(serviceDirectives, "MemoryDenyWriteExecute"), []);

    // The system-call filter is the broker's proven set, not a tighter guess.
    const broker = parseUnit(await readFile(join(SYSTEMD, "videofetch-r2-broker.service"), "utf8"));
    assert.deepEqual(
      values(serviceDirectives, "SystemCallFilter"),
      values(broker, "SystemCallFilter"),
      "the probe's syscall filter must match the broker's Production-proven Node filter",
    );
  });

  it("keeps the host loopback it must measure", () => {
    // PrivateNetwork=yes would give the unit its OWN empty loopback, and the
    // probe would measure nothing while reporting a clean connection failure.
    assert.deepEqual(values(serviceDirectives, "PrivateNetwork"), []);
    const families = tokens(serviceDirectives, "RestrictAddressFamilies");
    assert.ok(families.includes("AF_INET"), "loopback TCP is reachable");
    assert.ok(families.includes("AF_UNIX"), "the systemd unit-state query is reachable");
    assert.ok(!families.includes("AF_PACKET"), "no raw packet access");
    assert.ok(!families.includes("AF_NETLINK"), "no netlink access");
  });

  it("neither joins the media namespace nor invokes a container runtime", () => {
    for (const forbidden of [/nsenter/, /\bdocker\b/, /docker\s+exec/, /NetworkNamespacePath/, /JoinsNamespaceOf/, /--network\s+container:/]) {
      assert.doesNotMatch(serviceExec, forbidden, `the probe unit must not use ${forbidden}`);
      assert.doesNotMatch(timerExec, forbidden);
    }
  });

  it("is NOT invoked from the Worker unit or from the namespace holder", () => {
    // The probe must not become a pre-start gate or a side effect of the things
    // it observes: a probe inside the Worker's own start path could not observe
    // the Worker being down, and one inside the holder would run in the
    // restricted namespace.
    for (const [name, exec] of [
      ["videofetch-worker.service", workerUnitExec],
      ["videofetch-media-netns.service", netnsUnitExec],
    ] as const) {
      assert.doesNotMatch(
        exec,
        /vf-worker-liveness-probe|videofetch-worker-liveness/,
        `${name} must not invoke the liveness probe`,
      );
    }
  });

  it("adds no LAN or public Worker bind", () => {
    // The holder still publishes on loopback only, and the liveness work
    // introduces no second listener of its own.
    assert.match(netnsUnitExec, /-p\s+127\.0\.0\.1:\$\{VIDEOFETCH_WORKER_PORT\}:\$\{VIDEOFETCH_WORKER_PORT\}/);
    assert.doesNotMatch(netnsUnitExec, /-p\s+0\.0\.0\.0:/);
    for (const exec of [serviceExec, timerExec]) {
      assert.doesNotMatch(exec, /0\.0\.0\.0/, "the liveness units publish nothing");
      assert.doesNotMatch(exec, /ListenStream|ListenDatagram/, "no socket is created");
      assert.doesNotMatch(exec, /\s-p\s/, "no port publication");
    }
  });

  it("gets the port from the SAME file, by the SAME parser, that publishes the Worker", async () => {
    const template = await readFile(EGRESS_ENV_TEMPLATE, "utf8");
    assert.match(template, /^VIDEOFETCH_WORKER_PORT=/m, "the declaration lives here");

    // The holder expands ${VIDEOFETCH_WORKER_PORT} from its EnvironmentFile=, and
    // the probe unit names the identical file. One file, one systemd parser, two
    // consumers — there is no second port setting and no copy of the value.
    const netnsDirectives = parseUnit(await readFile(NETNS_UNIT, "utf8"));
    const strip = (v: string) => v.replace(/^-/, "");
    const holderFiles = values(netnsDirectives, "EnvironmentFile").map(strip);
    const probeFiles = values(serviceDirectives, "EnvironmentFile").map(strip);
    assert.deepEqual(holderFiles, ["/etc/videofetch/media-egress.env"]);
    assert.deepEqual(probeFiles, holderFiles, "the probe reads exactly the holder's file");
  });

  it("lets PID 1, not the probe's account, read the root-only configuration", () => {
    // REVIEW-CORRECTION-001, finding 1. /etc/videofetch stays 0700. PID 1 reads
    // the file as root before dropping privilege; the unprivileged process only
    // ever sees the resulting environment value. The static-account correction
    // changes WHO the process is, not how its configuration reaches it.
    assert.deepEqual(
      values(serviceDirectives, "EnvironmentFile"),
      ["-/etc/videofetch/media-egress.env"],
      "the manager reads it; a missing file reaches the probe as an empty value",
    );
    // Pinned FIRST, so the value is the file's or nothing — never inherited
    // from the service manager's own environment block.
    assert.ok(
      values(serviceDirectives, "Environment").includes("VIDEOFETCH_WORKER_PORT="),
      "VIDEOFETCH_WORKER_PORT is pinned empty before the file overrides it",
    );
    // The probe consumes one value and is handed one.
    assert.ok(tokens(serviceDirectives, "UnsetEnvironment").includes("VIDEOFETCH_MEDIA_DNS_FLAGS"));

    // Nothing makes /etc/videofetch reachable to the process, and nothing else
    // from it is delivered.
    for (const key of ["ReadOnlyPaths", "ReadWritePaths", "BindPaths", "BindReadOnlyPaths", "LoadCredential", "LoadCredentialEncrypted", "SetCredential", "ImportCredential"]) {
      assert.deepEqual(values(serviceDirectives, key), [], `${key}= must not be used`);
    }
    // Not root, by any route: the process is the dedicated static account (see
    // the identity suite) and nothing grants it more.
    assert.deepEqual(values(serviceDirectives, "User"), [LIVENESS_ACCOUNT]);
    assert.deepEqual(values(serviceDirectives, "Group"), [LIVENESS_ACCOUNT]);
    for (const key of ["SupplementaryGroups", "PermissionsStartOnly"]) {
      assert.deepEqual(values(serviceDirectives, key), [], `${key}= must not be set`);
    }
    assert.doesNotMatch(serviceExec, /ExecStart[A-Za-z]*=\s*[+!]/, "no privileged ExecStart prefix");
  });

  it("grants no writable path of any kind", () => {
    for (const key of ["StateDirectory", "RuntimeDirectory", "CacheDirectory", "LogsDirectory", "ConfigurationDirectory", "ReadWritePaths"]) {
      assert.deepEqual(values(serviceDirectives, key), [], `${key}= must not be set`);
    }
    assert.equal(values(serviceDirectives, "ProtectSystem")[0], "strict");
  });

  it("does not touch the safe-egress policy or its configuration", () => {
    for (const exec of [serviceExec, timerExec]) {
      for (const forbidden of [/vf-egress-policy-install/, /vf-egress-policy-verify/, /vf-egress-watchdog/, /\.nft\b/, /videofetch-egress/]) {
        assert.doesNotMatch(exec, forbidden, `the liveness units must not touch ${forbidden}`);
      }
    }
  });
});

describe("liveness probe runtime identity — a dedicated static account", () => {
  // WORKER-LIVENESS-STATIC-USER-CORRECTION-001.
  //
  // The first live deployment (2026-09-26) ran this unit as DynamicUser=yes. On
  // the Production Lima VM — systemd 255, classic dbus-daemon 1.14.10 — its
  // first timer tick reported OUTCOME=state-unavailable: the read-only
  // `systemctl show` failed with "Transport endpoint is not connected". A
  // DynamicUser with the other hardening removed failed the same way, and a
  // static unprivileged identity made the same query successfully. The
  // deployment was rolled back.
  //
  // No repository test can emulate that VM's D-Bus, and none of these pretends
  // to. What they CAN do is make the measured prerequisite — a stable,
  // statically provisioned identity — a structural property of the unit, so a
  // revert to DynamicUser= fails here instead of on the VM. The live proof that
  // the account can make the query is an install-time check in
  // deploy/README.md, and it must pass before the timer is enabled.
  let service: string;
  let serviceDirectives: string[];
  let serviceExec: string;

  before(async () => {
    service = await readFile(LIVENESS_SERVICE, "utf8");
    serviceDirectives = parseUnit(service);
    serviceExec = executableLines(service);
  });

  it("runs as the dedicated static account, with its own group and no other", () => {
    assert.deepEqual(staticIdentityViolations(serviceDirectives), []);
    assert.deepEqual(values(serviceDirectives, "User"), [LIVENESS_ACCOUNT]);
    assert.deepEqual(values(serviceDirectives, "Group"), [LIVENESS_ACCOUNT]);
    assert.deepEqual(values(serviceDirectives, "SupplementaryGroups"), []);
  });

  it("is NOT a transient DynamicUser, the identity that could not query systemd on the Production VM", () => {
    assert.deepEqual(
      values(serviceDirectives, "DynamicUser"),
      [],
      "DynamicUser= must be absent: on the Production VM a DynamicUser could not complete " +
        "the read-only systemd query this probe depends on (OUTCOME=state-unavailable)",
    );
  });

  it("rejects a regression back to DynamicUser=yes, and every other wrong identity", () => {
    // Deliberately regressed copies of the SHIPPED unit. Every one must be
    // caught; a contract that accepted any of them would be one in name only.
    const identity = `User=${LIVENESS_ACCOUNT}\nGroup=${LIVENESS_ACCOUNT}\n`;
    assert.ok(service.includes(identity), "the shipped unit declares its identity as one block");
    const mutants: Array<[string, string]> = [
      ["the PR #83 identity (DynamicUser=yes, no User=/Group=)", service.replace(identity, "DynamicUser=yes\n")],
      ["DynamicUser=yes alongside the static account", service.replace(identity, `${identity}DynamicUser=yes\n`)],
      ["no User=/Group= at all, which systemd runs as root", service.replace(identity, "")],
      ["User=root", service.replace(identity, `User=root\nGroup=${LIVENESS_ACCOUNT}\n`)],
      ["User=nobody", service.replace(identity, "User=nobody\nGroup=nogroup\n")],
      ["the broker's account", service.replace(identity, "User=videofetch-broker\nGroup=videofetch-broker\n")],
      ["the broker's group", service.replace(identity, `User=${LIVENESS_ACCOUNT}\nGroup=videofetch-broker\n`)],
      ["docker membership", service.replace(identity, `${identity}SupplementaryGroups=docker\n`)],
      ["broker-group membership", service.replace(identity, `${identity}SupplementaryGroups=videofetch-broker\n`)],
    ];
    for (const [name, mutant] of mutants) {
      assert.notEqual(mutant, service, `${name}: the mutation must actually change the unit`);
      assert.ok(
        staticIdentityViolations(parseUnit(mutant)).length > 0,
        `${name} must be rejected by the identity contract`,
      );
    }
  });

  it("keeps every protection the DynamicUser revision had, now stated explicitly", () => {
    // DynamicUser= implied ProtectSystem=strict, ProtectHome=read-only,
    // PrivateTmp=, NoNewPrivileges=, RestrictSUIDSGID= and RemoveIPC=. Each is
    // declared here, so moving to a static account weakened nothing.
    const required: Array<[string, string]> = [
      ["NoNewPrivileges", "yes"],
      ["CapabilityBoundingSet", ""],
      ["AmbientCapabilities", ""],
      ["ProtectSystem", "strict"],
      ["ProtectHome", "yes"],
      ["PrivateTmp", "yes"],
      ["PrivateDevices", "yes"],
      ["ProtectKernelTunables", "yes"],
      ["ProtectKernelModules", "yes"],
      ["ProtectKernelLogs", "yes"],
      ["ProtectControlGroups", "yes"],
      ["ProtectClock", "yes"],
      ["ProtectHostname", "yes"],
      ["ProtectProc", "invisible"],
      ["LockPersonality", "yes"],
      ["RestrictRealtime", "yes"],
      ["RestrictSUIDSGID", "yes"],
      ["RestrictNamespaces", "yes"],
      ["SystemCallArchitectures", "native"],
      ["RemoveIPC", "yes"],
      ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6"],
    ];
    for (const [key, value] of required) {
      assert.deepEqual(values(serviceDirectives, key), [value], `${key}=${value} is required, exactly once`);
    }
    // Host loopback must stay reachable, so there is still no PrivateNetwork=.
    assert.deepEqual(values(serviceDirectives, "PrivateNetwork"), []);
  });

  it("brings no state, home directory or writable path with the account", () => {
    for (const key of [
      "StateDirectory",
      "RuntimeDirectory",
      "CacheDirectory",
      "LogsDirectory",
      "ConfigurationDirectory",
      "ReadWritePaths",
      "BindPaths",
      "WorkingDirectory",
    ]) {
      assert.deepEqual(values(serviceDirectives, key), [], `${key}= must not be set`);
    }
  });

  it("adds no credential and no configuration beyond the one delivered port", () => {
    assert.deepEqual(values(serviceDirectives, "Environment"), ["VIDEOFETCH_WORKER_PORT="]);
    assert.deepEqual(values(serviceDirectives, "EnvironmentFile"), ["-/etc/videofetch/media-egress.env"]);
    for (const key of [
      "LoadCredential",
      "LoadCredentialEncrypted",
      "SetCredential",
      "SetCredentialEncrypted",
      "ImportCredential",
      "PassEnvironment",
    ]) {
      assert.deepEqual(values(serviceDirectives, key), [], `${key}= must not be set`);
    }
    for (const forbidden of [/r2-broker\.env/, /worker\.env/, /broker-gid\.env/, /secret/i, /token/i]) {
      assert.doesNotMatch(serviceExec, forbidden, `the probe unit must not reference ${forbidden}`);
    }
  });
});

describe("the liveness install procedure provisions and verifies the account BEFORE the timer", () => {
  // The unit cannot create its own account, and must not: systemd would refuse
  // to start it (status=217/USER), and a unit that provisions users is a
  // privileged unit. So the ordering lives in the operator procedure, and this
  // suite pins it.
  let commands: string[];
  let enableAt: number;

  const firstIndex = (pattern: RegExp) => commands.findIndex((line) => pattern.test(line));

  before(async () => {
    commands = logicalCommands(await readFile(DEPLOY_README, "utf8"));
    enableAt = firstIndex(/^systemctl enable --now videofetch-worker-liveness\.timer\b/);
  });

  it("enables the timer somewhere, so the ordering checks below are not vacuous", () => {
    assert.ok(enableAt >= 0, "deploy/README.md must enable videofetch-worker-liveness.timer");
  });

  it("creates the group and the account idempotently, before enabling the timer", () => {
    const group = firstIndex(
      /^getent group videofetch-liveness\b.*\|\|\s*groupadd --system videofetch-liveness$/,
    );
    const user = firstIndex(/^getent passwd videofetch-liveness\b.*\|\|\s*useradd --system\b.*\bvideofetch-liveness$/);
    assert.ok(group >= 0 && group < enableAt, "the group is created, once, before the timer is enabled");
    assert.ok(user >= 0 && user < enableAt, "the account is created, once, before the timer is enabled");

    const useradd = commands[user]!;
    for (const required of ["--no-create-home", "--home-dir /nonexistent", "--shell /usr/sbin/nologin", "--gid videofetch-liveness"]) {
      assert.ok(useradd.includes(required), `useradd must pass ${required}`);
    }
    // Its own group and nothing else: no docker, no broker group.
    assert.doesNotMatch(useradd, /\s(-G|--groups|-aG|--append)\b/);
  });

  it("verifies the account's groups before enabling the timer", () => {
    const check = firstIndex(/^id -Gn videofetch-liveness\b/);
    assert.ok(check >= 0 && check < enableAt, "`id -Gn videofetch-liveness` is checked first");
  });

  it("proves AS THE SERVICE ACCOUNT that it can run the pinned Node, after creating it and before the timer", () => {
    const user = firstIndex(/^getent passwd videofetch-liveness\b/);
    const node = firstIndex(
      /^systemd-run\b.*-p User=videofetch-liveness\b.*-p Group=videofetch-liveness\b.*\/opt\/videofetch\/node\/bin\/node -v\b/,
    );
    assert.ok(node > user && node < enableAt, "the Node check runs as videofetch-liveness, between 6a and 6d");
  });

  it("proves AS THE SERVICE ACCOUNT that it can make the exact systemd query, before the timer", () => {
    // The live failure was precisely this query. It must be exercised as the
    // real identity, read-only, before anything depends on it.
    const user = firstIndex(/^getent passwd videofetch-liveness\b/);
    const query = firstIndex(
      /^systemd-run\b.*-p User=videofetch-liveness\b.*-p Group=videofetch-liveness\b.*systemctl show\b.*--property=LoadState\b.*--property=ActiveState\b.*--property=SubState\b.*\bvideofetch-worker\.service\b/,
    );
    assert.ok(query > user && query < enableAt, "the systemd query runs as videofetch-liveness, between 6a and 6d");
    assert.doesNotMatch(commands[query]!, /\b(start|stop|restart|reload|kill)\b/, "the check is read-only");

    // Then one on-demand run of the real unit, under its full sandbox, still
    // before the timer exists.
    const onDemand = firstIndex(/^systemctl start videofetch-worker-liveness\.service$/);
    assert.ok(onDemand > query && onDemand < enableAt, "one on-demand run precedes enabling the timer");
  });

  it("no longer prescribes a DynamicUser check, and never adds the account to another group", () => {
    assert.deepEqual(
      commands.filter((line) => /^systemd-run\b.*DynamicUser=yes/.test(line)),
      [],
      "the DynamicUser prerequisite is obsolete: it is not the identity the unit runs as",
    );
    assert.deepEqual(
      commands.filter((line) => /^(usermod|gpasswd|adduser)\b.*videofetch-liveness/.test(line)),
      [],
      "videofetch-liveness is never added to docker, the broker group or any other group",
    );
  });
});

describe("the Worker image is unchanged by the liveness work", () => {
  let dockerExec: string;

  before(async () => {
    const source = await readFile(DOCKERFILE, "utf8");
    dockerExec = source
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  });

  it("still declares NO HEALTHCHECK", () => {
    assert.doesNotMatch(dockerExec, /\bHEALTHCHECK\b/i);
  });

  it("gained no health-only HTTP client as a consequence of this task", () => {
    // The whole reason the probe lives on the host is that the image must not
    // grow a client for a destination the egress policy denies.
    for (const forbidden of ["curl", "wget", "httpie"]) {
      assert.doesNotMatch(
        dockerExec,
        new RegExp(`(^|[\\s=])${forbidden}([\\s=]|$)`),
        `the Worker image must not install ${forbidden}`,
      );
    }
  });

  it("still probes no loopback or private destination from inside the namespace", () => {
    for (const forbidden of [/127\.0\.0\.1/, /\blocalhost\b/i, /\[::1\]/]) {
      assert.doesNotMatch(dockerExec, forbidden);
    }
  });

  it("gained no capability, privilege or namespace change", async () => {
    const workerUnitExec = executableLines(await readFile(WORKER_UNIT, "utf8"));
    assert.match(workerUnitExec, /--cap-drop=ALL/);
    assert.match(workerUnitExec, /--security-opt no-new-privileges/);
    assert.match(workerUnitExec, /--read-only/);
    assert.match(workerUnitExec, /--network container:videofetch-media-netns/);
    for (const forbidden of [/NET_ADMIN/, /SYS_ADMIN/, /--privileged/, /--network\s+host/, /docker\.sock/, /--cap-add/]) {
      assert.doesNotMatch(workerUnitExec, forbidden);
    }
  });
});

describe("liveness probe behaviour", () => {
  let sandbox: string;
  let env: NodeJS.ProcessEnv;
  /** Connections observed by whatever listener a test installed. */
  let connections: number;
  let server: Server | net.Server | null = null;
  let port = 0;

  /** Rewrites the stub `systemctl`'s answer for the Worker unit. */
  const setUnitState = (props: Record<string, string>) =>
    writeFile(
      join(sandbox, "unit-show"),
      `${Object.entries(props)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );

  const setIsFailed = (value: string) => writeFile(join(sandbox, "is-failed"), `${value}\n`);

  /**
   * The port PID 1 would deliver. In the deployed unit it arrives through
   * EnvironmentFile=; here it is placed in the child's environment directly,
   * which is exactly what the probe observes either way.
   */
  let configuredPort: string | undefined = "1";
  const setConfiguredPort = async (value: number | string) => {
    configuredPort = String(value);
  };

  /**
   * ASYNC on purpose, exactly as the DNS readiness suite is.
   *
   * The loopback listeners these tests install live in THIS process, so a
   * spawnSync() here would block the event loop for the whole child run and no
   * listener could ever answer. Every "active and healthy" case would then time
   * out, and every failure case would pass for entirely the wrong reason — a
   * timeout is not a malformed body.
   */
  function runProbe(
    extra: NodeJS.ProcessEnv = {},
    { args = [], signalAfterMs }: { args?: string[]; signalAfterMs?: number } = {},
  ): Promise<{ status: number | null; stdout: string; stderr: string; outcome: string; outcomeCount: number }> {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    if (configuredPort !== undefined) childEnv.VIDEOFETCH_WORKER_PORT = configuredPort;
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    return new Promise((resolve) => {
      const child = spawn("bash", [PROBE_SCRIPT, ...args], { env: childEnv });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      const signalTimer =
        signalAfterMs === undefined ? null : setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
      child.on("close", (status) => {
        clearTimeout(timer);
        if (signalTimer) clearTimeout(signalTimer);
        const all = `${stdout}${stderr}`;
        const outcome = /OUTCOME=(\S+)/.exec(all)?.[1] ?? "";
        const outcomeCount = (all.match(/OUTCOME=/g) ?? []).length;
        resolve({ status, stdout, stderr, outcome, outcomeCount });
      });
    });
  }

  /** Installs an HTTP listener on loopback, recording every request line. */
  async function listen(handler: (req: any, res: any) => void): Promise<void> {
    await closeServer();
    connections = 0;
    const s = createServer((req, res) => {
      connections += 1;
      requests.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    s.on("connection", (socket) => sockets.add(socket));
    server = s;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    port = (s.address() as net.AddressInfo).port;
    await setConfiguredPort(port);
  }

  /** A raw TCP listener that accepts and never answers, to exercise the deadline. */
  async function listenSilently(): Promise<void> {
    await closeServer();
    connections = 0;
    const s = net.createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      // Deliberately no response, ever. The socket stays open so the peer sees a
      // live connection rather than a reset — a reset would be tested as
      // connect-failed, not as the deadline.
      socket.resume();
      socket.on("error", () => socket.destroy());
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    port = (s.address() as net.AddressInfo).port;
    await setConfiguredPort(port);
  }

  /**
   * Closes the current listener AND destroys every socket it accepted.
   *
   * `server.close()` stops accepting but waits for existing connections, and the
   * silent listener deliberately holds one open forever — so without the explicit
   * socket teardown this would never resolve and the run would hang after the
   * timeout test.
   */
  async function closeServer(): Promise<void> {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (!server) return;
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  const sockets = new Set<net.Socket>();
  let requests: string[] = [];

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "vf-liveness-"));
    const bin = join(sandbox, "bin");
    await mkdir(bin);

    // The stub systemctl. It ANSWERS read-only queries from fixture files and
    // RECORDS anything else, so a test can prove the probe never asked systemd
    // to change state.
    const stubs: Record<string, string> = {
      systemctl: `#!/bin/bash
if [ "$1" = "show" ]; then cat "$VT/unit-show"; exit 0; fi
if [ "$1" = "is-failed" ]; then cat "$VT/is-failed" 2>/dev/null || echo inactive; exit 0; fi
echo "systemctl $*" >> "$VT/mutations.log"
exit 0
`,
      // `systemctl show` exits 0 even for a missing unit, so a nonzero exit is
      // systemd itself being unreachable — e.g. D-Bus denied by a sandbox.
      "systemctl-broken": `#!/bin/bash\nexit 1\n`,
      // Present on PATH purely so a test can prove they are never called.
      docker: `#!/bin/bash\necho "docker $*" >> "$VT/mutations.log"\nexit 0\n`,
      nsenter: `#!/bin/bash\necho "nsenter $*" >> "$VT/mutations.log"\nexit 0\n`,
      nft: `#!/bin/bash\necho "nft $*" >> "$VT/mutations.log"\nexit 0\n`,
      curl: `#!/bin/bash\necho "curl $*" >> "$VT/mutations.log"\nexit 0\n`,
      wget: `#!/bin/bash\necho "wget $*" >> "$VT/mutations.log"\nexit 0\n`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(bin, name);
      await writeFile(path, body);
      await chmod(path, 0o755);
    }

    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
    await setIsFailed("active");
    await setConfiguredPort(1);

    const rootOnly = join(sandbox, "etc-videofetch");
    await mkdir(rootOnly);
    await writeFile(
      join(rootOnly, "media-egress.env"),
      'VIDEOFETCH_WORKER_PORT=9\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 10.11.12.13"\n',
    );
    await chmod(rootOnly, 0o000);

    env = {
      ...process.env,
      VT: sandbox,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      VF_EGRESS_LIB: EGRESS_LIB,
      // A stand-in for the root-only /etc/videofetch: a directory this process
      // cannot traverse, holding a perfectly valid media-egress.env. If the probe
      // ever regressed to reading the file itself, every run would die here.
      VF_CONFIG_FILE: join(sandbox, "etc-videofetch", "media-egress.env"),
      VF_SYSTEMCTL: join(bin, "systemctl"),
      // The pinned host Node does not exist on this machine; the test's own
      // interpreter stands in for it. This is exactly the seam the safe-egress
      // helpers use for `nft`, `ip` and `docker`.
      VF_NODE: process.execPath,
      VF_WORKER_HEALTH_REQUEST: REQUEST_MODULE,
      VF_LIVENESS_TIMEOUT_MS: "4000",
    };
  });

  after(async () => {
    await closeServer();
    await chmod(join(sandbox, "etc-videofetch"), 0o700).catch(() => {});
    await rm(sandbox, { recursive: true, force: true });
  });

  it("succeeds when the Worker is active and healthy", async () => {
    requests = [];
    await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

    const run = await runProbe();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(run.outcome, "healthy");
  });

  it("requests loopback, the CONFIGURED port and exactly /v1/healthz", async () => {
    requests = [];
    let observedHostHeader = "";
    let observedRemote = "";
    await listen((req, res) => {
      observedHostHeader = String(req.headers.host ?? "");
      observedRemote = String(req.socket.remoteAddress ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

    const run = await runProbe();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(requests, ["GET /v1/healthz"], "exactly one request, to the exact path");
    assert.equal(observedHostHeader, `127.0.0.1:${port}`, "the configured loopback port");
    assert.match(observedRemote, /^(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/, "the peer is loopback");
    // And the probe reported the target it actually used.
    assert.match(run.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/v1/healthz`));
  });

  it("classifies an inactive Worker as intentional idle, WITHOUT any request", async () => {
    requests = [];
    await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await setUnitState({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead" });
    await setIsFailed("inactive");

    const run = await runProbe();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(run.outcome, "idle");
    // THE DISCRIMINATION: a healthy listener was sitting there and was still not
    // contacted, so "idle" is a real short-circuit rather than a lucky pass.
    assert.equal(connections, 0, "no connection was opened");
    assert.deepEqual(requests, [], "no HTTP request was attempted");
  });

  it("classifies a transient activating Worker as not-applicable, without a request", async () => {
    requests = [];
    await listen((req, res) => {
      res.writeHead(500);
      res.end("{}");
    });
    for (const state of ["activating", "deactivating", "reloading"]) {
      await setUnitState({ LoadState: "loaded", ActiveState: state, SubState: "start" });
      const run = await runProbe();
      assert.equal(run.status, 0, `${state}: ${run.stdout}${run.stderr}`);
      assert.equal(run.outcome, "transient", `${state} is a bounded transient`);
    }
    assert.equal(connections, 0, "a mid-start Worker is not probed");
  });

  it("FAILS on a failed Worker unit, and never disguises it as idle", async () => {
    await setUnitState({ LoadState: "loaded", ActiveState: "failed", SubState: "failed" });
    await setIsFailed("failed");

    const run = await runProbe();
    assert.equal(run.status, 1);
    assert.equal(run.outcome, "failed-unit");
    assert.notEqual(run.outcome, "idle");
  });

  it("FAILS a unit that `is-failed` reports failed even if ActiveState disagrees", async () => {
    // Belt and braces: the two predicates are read independently, so a
    // disagreement resolves to the unsafe-looking answer, not the comfortable one.
    await setUnitState({ LoadState: "loaded", ActiveState: "inactive", SubState: "failed" });
    await setIsFailed("failed");

    const run = await runProbe();
    assert.equal(run.status, 1);
    assert.equal(run.outcome, "failed-unit");
  });

  it("reports a not-installed unit as a deployment fault, not as idle", async () => {
    await setUnitState({ LoadState: "not-found", ActiveState: "inactive", SubState: "dead" });
    await setIsFailed("inactive");

    const run = await runProbe();
    assert.equal(run.status, 2);
    assert.equal(run.outcome, "not-installed");
  });

  it("FAILS on an ActiveState it does not understand", async () => {
    await setUnitState({ LoadState: "loaded", ActiveState: "banana", SubState: "dead" });
    await setIsFailed("inactive");

    const run = await runProbe();
    assert.equal(run.status, 1);
    assert.equal(run.outcome, "unknown-state");
  });

  it("FAILS when the connection is refused", async () => {
    await closeServer();
    // An ephemeral port that was just released: nothing is listening.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await setConfiguredPort(deadPort);
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
    await setIsFailed("active");

    const run = await runProbe();
    assert.equal(run.status, 1);
    assert.equal(run.outcome, "unhealthy");
    assert.match(`${run.stdout}${run.stderr}`, /outcome=connect-failed/);
  });

  it("FAILS on a timeout rather than hanging the timer unit", async () => {
    await listenSilently();
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

    const started = Date.now();
    const run = await runProbe({ VF_LIVENESS_TIMEOUT_MS: "700" });
    const elapsed = Date.now() - started;

    assert.equal(run.status, 1);
    assert.equal(run.outcome, "unhealthy");
    assert.match(`${run.stdout}${run.stderr}`, /outcome=timeout/);
    assert.equal(connections, 1, "the connection was made, then abandoned");
    assert.ok(elapsed < 20_000, `the probe must return promptly, took ${elapsed}ms`);
  });

  it("FAILS on a non-200 response", async () => {
    for (const status of [204, 301, 302, 401, 403, 500, 503]) {
      requests = [];
      await listen((req, res) => {
        res.writeHead(status, { "Content-Type": "application/json", location: "/elsewhere" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

      const run = await runProbe();
      assert.equal(run.status, 1, `HTTP ${status} must fail`);
      assert.equal(run.outcome, "unhealthy");
      assert.match(`${run.stdout}${run.stderr}`, /outcome=bad-status/);
      // A 3xx carrying a healthy-looking body must not be chased.
      assert.deepEqual(requests, ["GET /v1/healthz"], `HTTP ${status}: no redirect was followed`);
    }
  });

  it("FAILS on a malformed body", async () => {
    for (const body of ["not json at all", "<html>login</html>", "[]", '"ok"', "null", "42"]) {
      await listen((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      });
      await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

      const run = await runProbe();
      assert.equal(run.status, 1, `body ${body} must fail`);
      assert.match(`${run.stdout}${run.stderr}`, /outcome=malformed-body/, `body ${body}`);
    }
  });

  it("FAILS on a health state other than ok", async () => {
    for (const state of ["degraded", "OK", "starting", "", "ready"]) {
      await listen((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: state }));
      });
      await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

      const run = await runProbe();
      assert.equal(run.status, 1, `state '${state}' must fail`);
      assert.match(`${run.stdout}${run.stderr}`, /outcome=wrong-state/, `state '${state}'`);
    }
  });

  it("FAILS on a body larger than the cap", async () => {
    await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`{"status":"ok","pad":"${"x".repeat(8192)}"}`);
    });
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

    const run = await runProbe();
    assert.equal(run.status, 1);
    assert.match(`${run.stdout}${run.stderr}`, /outcome=body-too-large/);
  });

  it("refuses a malformed configured port instead of guessing one", async () => {
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
    for (const bad of ["", "0", "70000", "not-a-port", "80 80"]) {
      await setConfiguredPort(bad);
      const run = await runProbe();
      assert.equal(run.status, 2, `port '${bad}' must be refused`);
      assert.equal(run.outcome, "config-invalid");
    }
  });

  it("rejects an unknown argument rather than probing anyway", () => {
    const result = spawnSync("bash", [PROBE_SCRIPT, "--restart-worker"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
  });

  it("works WITHOUT any access to the root-only configuration directory", async () => {
    // REVIEW-CORRECTION-001, finding 1, behaviourally. VF_CONFIG_FILE points
    // into a directory this process cannot traverse — the probe account's view
    // of /etc/videofetch — and the probe still succeeds on the delivered value.
    await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
    await setIsFailed("active");

    const run = await runProbe();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(run.outcome, "healthy");
  });

  it("does NOT fall back to reading the file when the delivered value is absent", async () => {
    // A readable media-egress.env with a valid port is offered through the
    // library's own seam. If the probe consulted it, this would not be a
    // config fault — so a port-unavailable verdict proves it never looked.
    const readable = join(sandbox, "readable-media-egress.env");
    await writeFile(readable, `VIDEOFETCH_WORKER_PORT=${port || 8080}\n`);
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

    const run = await runProbe({ VIDEOFETCH_WORKER_PORT: undefined, VF_CONFIG_FILE: readable });
    assert.equal(run.status, 2);
    assert.equal(run.outcome, "config-invalid");
    assert.match(run.stdout, /reason=port-unavailable/);
  });

  it("emits EXACTLY ONE OUTCOME line on every expected path", async () => {
    // REVIEW-CORRECTION-001: the first revision could exit from inside the
    // shared config loader with no OUTCOME line at all.
    const cases: Array<{
      name: string;
      setup: () => Promise<void>;
      extra?: NodeJS.ProcessEnv;
      args?: string[];
      outcome: string;
      status: number;
    }> = [];

    const healthy = async () => {
      await listen((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
    };
    const unit = (active: string, failed = "inactive", load = "loaded") => async () => {
      await healthy();
      await setUnitState({ LoadState: load, ActiveState: active, SubState: active });
      await setIsFailed(failed);
    };

    cases.push(
      { name: "configuration unavailable (unset)", setup: unit("active", "active"), extra: { VIDEOFETCH_WORKER_PORT: undefined }, outcome: "config-invalid", status: 2 },
      { name: "port missing (empty)", setup: unit("active", "active"), extra: { VIDEOFETCH_WORKER_PORT: "" }, outcome: "config-invalid", status: 2 },
      { name: "malformed port", setup: unit("active", "active"), extra: { VIDEOFETCH_WORKER_PORT: "80 80" }, outcome: "config-invalid", status: 2 },
      { name: "out-of-range port", setup: unit("active", "active"), extra: { VIDEOFETCH_WORKER_PORT: "70000" }, outcome: "config-invalid", status: 2 },
      { name: "shared validator unavailable", setup: unit("active", "active"), extra: { VF_EGRESS_LIB: join(sandbox, "no-such-lib.sh") }, outcome: "config-invalid", status: 2 },
      { name: "host Node missing", setup: unit("active", "active"), extra: { VF_NODE: join(sandbox, "no-such-node") }, outcome: "config-invalid", status: 2 },
      { name: "request module missing", setup: unit("active", "active"), extra: { VF_WORKER_HEALTH_REQUEST: join(sandbox, "no-such.mjs") }, outcome: "config-invalid", status: 2 },
      { name: "systemd unreachable", setup: unit("active", "active"), extra: { VF_SYSTEMCTL: join(sandbox, "bin", "systemctl-broken") }, outcome: "state-unavailable", status: 2 },
      { name: "Worker unit not installed", setup: unit("inactive", "inactive", "not-found"), outcome: "not-installed", status: 2 },
      { name: "Worker failed", setup: unit("failed", "failed"), outcome: "failed-unit", status: 1 },
      { name: "unknown Worker state", setup: unit("banana"), outcome: "unknown-state", status: 1 },
      { name: "idle", setup: unit("inactive"), outcome: "idle", status: 0 },
      { name: "transient", setup: unit("activating"), outcome: "transient", status: 0 },
      { name: "healthy", setup: unit("active", "active"), outcome: "healthy", status: 0 },
      {
        name: "unhealthy request",
        setup: async () => {
          await listen((req, res) => {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end("{}");
          });
          await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
          await setIsFailed("active");
        },
        outcome: "unhealthy",
        status: 1,
      },
      { name: "usage error", setup: unit("active", "active"), args: ["--restart-worker"], outcome: "usage-error", status: 2 },
    );

    for (const c of cases) {
      await c.setup();
      const run = await runProbe(c.extra ?? {}, { args: c.args ?? [] });
      assert.equal(run.outcomeCount, 1, `${c.name}: exactly one OUTCOME line, got ${run.outcomeCount}:\n${run.stdout}${run.stderr}`);
      assert.equal(run.outcome, c.outcome, `${c.name}: outcome`);
      assert.equal(run.status, c.status, `${c.name}: exit status`);
    }
  });

  it("reports an UNEXPECTED exit as exactly one internal-error, never as success", async () => {
    // A library that exits while being sourced stands in for any path that
    // escapes verdict(): an unbound variable, a helper that calls exit, a bug.
    const exiting = join(sandbox, "exiting-lib.sh");
    await writeFile(exiting, "exit 0\n");
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });

    const run = await runProbe({ VF_EGRESS_LIB: exiting });
    assert.equal(run.outcomeCount, 1, `${run.stdout}${run.stderr}`);
    assert.equal(run.outcome, "internal-error");
    assert.equal(run.status, 2, "an escaped exit 0 must not read as healthy or idle");
  });

  it("reports termination by signal as exactly one interrupted outcome", async () => {
    await listenSilently();
    await setUnitState({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
    await setIsFailed("active");

    const run = await runProbe({ VF_LIVENESS_TIMEOUT_MS: "1500" }, { signalAfterMs: 300 });
    assert.equal(run.outcomeCount, 1, `${run.stdout}${run.stderr}`);
    assert.equal(run.outcome, "interrupted");
    assert.equal(run.status, 2);
  });

  it("NEVER starts, stops or restarts anything, and never invokes docker or nsenter", async () => {
    // Replays the whole state machine and then inspects the recording. Every
    // mutating tool is on PATH, so a call would be captured rather than fail.
    await rm(join(sandbox, "mutations.log"), { force: true });

    await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    for (const [state, failed] of [
      ["active", "active"],
      ["inactive", "inactive"],
      ["activating", "inactive"],
      ["failed", "failed"],
    ] as const) {
      await setUnitState({ LoadState: "loaded", ActiveState: state, SubState: state });
      await setIsFailed(failed);
      await runProbe();
    }
    await setUnitState({ LoadState: "not-found", ActiveState: "inactive", SubState: "dead" });
    await runProbe();

    let log = "";
    try {
      log = await readFile(join(sandbox, "mutations.log"), "utf8");
    } catch {
      log = "";
    }
    assert.equal(
      log.trim(),
      "",
      `the probe must invoke no mutating command; it invoked:\n${log}`,
    );
  });
});
