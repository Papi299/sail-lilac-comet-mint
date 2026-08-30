import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Static and behavioural policy guard for the safe-egress boundary
 * (PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001).
 *
 * Two halves, deliberately:
 *
 *   STATIC   — asserts the SEMANTICS of the units, the nftables template and
 *              the holder image: directive values, never formatting, in the
 *              style of the broker and container suites. Reordering or
 *              re-commenting an artefact cannot fail these; only a policy
 *              regression can.
 *
 *   BEHAVIOURAL — actually RUNS the shipped verifier and watchdog against
 *              recorded fixtures, with stub `docker`, `nsenter`, `nft` and `ip`
 *              on PATH. This is what proves the fail-closed claims, because a
 *              verifier that greps for the right strings but exits 0 anyway
 *              would pass every static test ever written.
 *
 * NOTHING HERE TOUCHES THE LIMA VM. Every fixture is a temporary directory and
 * every tool is a stub; no container runtime, namespace, root privilege or
 * network is used or required.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEPLOY = join(REPO_ROOT, "deploy");
const SYSTEMD = join(DEPLOY, "systemd");
const BIN = join(DEPLOY, "bin");

const WORKER_UNIT = join(SYSTEMD, "videofetch-worker.service");
const NETNS_UNIT = join(SYSTEMD, "videofetch-media-netns.service");
const POLICY_UNIT = join(SYSTEMD, "videofetch-egress-policy.service");
const WATCHDOG_UNIT = join(SYSTEMD, "videofetch-egress-watchdog.service");
const EGRESS_ENV_TEMPLATE = join(SYSTEMD, "media-egress.env.example");
const NFT_TEMPLATE = join(DEPLOY, "nftables", "videofetch-egress.nft.template");
const HOLDER_DOCKERFILE = join(DEPLOY, "media-netns", "Dockerfile");

const VERIFY_SCRIPT = join(BIN, "vf-egress-policy-verify");
const WATCHDOG_SCRIPT = join(BIN, "vf-egress-watchdog");
const INSTALL_SCRIPT = join(BIN, "vf-egress-policy-install");
const MULTICAST_SCRIPT = join(BIN, "vf-egress-multicast-route-test");
const LIB_SCRIPT = join(BIN, "vf-egress-lib.sh");

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

/**
 * Drops whole-line `#` comments. Assertions about what an artefact DOES must
 * not be satisfied — or broken — by prose. Several of these files deliberately
 * NAME the thing they refuse to do (the prototype's dangling breach target,
 * the acceptance-only helper), and a naive substring check would read those
 * explanations as the behaviour they warn against.
 */
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

// ── Required deny classes, from docs/architecture/safe-egress.md ────────────

const REQUIRED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/**
 * IPv6 is checked by CLASS, not by literal string, because more than one
 * spelling can express the same coverage. `::/96` is accepted for the
 * unspecified / loopback / IPv4-compatible group: it CONTAINS `::/128` and
 * `::1/128`, and nftables interval sets reject overlapping elements, so those
 * three classes cannot be listed separately alongside it.
 */
const REQUIRED_V6: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "unspecified", pattern: /::\/(96|128)/ },
  { label: "loopback", pattern: /::\/96|::1\/128/ },
  { label: "IPv4-compatible", pattern: /::\/96/ },
  { label: "IPv4-mapped", pattern: /::ffff:(0\.0\.0\.0|0:0)\/96/ },
  { label: "NAT64 well-known", pattern: /64:ff9b::\/32/ },
  { label: "Teredo", pattern: /2001::\/32/ },
  { label: "6to4", pattern: /2002::\/16/ },
  { label: "unique-local (ULA)", pattern: /fc00::\/7/ },
  { label: "link-local", pattern: /fe80::\/10/ },
  { label: "multicast", pattern: /ff00::\/8/ },
];

describe("safe-egress deployment policy", () => {
  let workerUnit: string[];
  let netnsUnit: string[];
  let policyUnit: string[];
  let watchdogUnit: string[];
  let workerSource: string;
  let netnsSource: string;
  let watchdogSource: string;
  let nftTemplate: string;
  let holderDockerfile: string;
  let envTemplate: string;
  let verifySource: string;
  let watchdogScript: string;
  let multicastScript: string;
  let installScript: string;

  before(async () => {
    workerSource = await readFile(WORKER_UNIT, "utf8");
    netnsSource = await readFile(NETNS_UNIT, "utf8");
    watchdogSource = await readFile(WATCHDOG_UNIT, "utf8");
    nftTemplate = await readFile(NFT_TEMPLATE, "utf8");
    holderDockerfile = await readFile(HOLDER_DOCKERFILE, "utf8");
    envTemplate = await readFile(EGRESS_ENV_TEMPLATE, "utf8");
    verifySource = await readFile(VERIFY_SCRIPT, "utf8");
    watchdogScript = await readFile(WATCHDOG_SCRIPT, "utf8");
    multicastScript = await readFile(MULTICAST_SCRIPT, "utf8");
    installScript = await readFile(INSTALL_SCRIPT, "utf8");

    workerUnit = parseUnit(workerSource);
    netnsUnit = parseUnit(netnsSource);
    policyUnit = parseUnit(await readFile(POLICY_UNIT, "utf8"));
    watchdogUnit = parseUnit(watchdogSource);
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("namespace holder", () => {
    it("uses the container name the Worker unit joins", () => {
      const exec = values(netnsUnit, "ExecStart").join("\n");
      assert.match(exec, /--name\s+videofetch-media-netns\b/);

      // The two must agree, or the Worker silently lands somewhere unpoliced.
      assert.match(
        values(workerUnit, "ExecStart").join("\n"),
        /--network\s+container:videofetch-media-netns\b/,
        "the Worker must join exactly this container's namespace",
      );
    });

    it("publishes the Worker port on VM LOOPBACK only", () => {
      const exec = values(netnsUnit, "ExecStart").join("\n");
      const publications = exec.match(/(?:-p|--publish)\s+\S+/g) ?? [];
      assert.ok(publications.length > 0, "the holder must publish the Worker's ingress port");

      for (const publication of publications) {
        assert.match(
          publication,
          /(?:-p|--publish)\s+127\.0\.0\.1:/,
          `port publication must bind VM loopback explicitly, found: ${publication}`,
        );
      }
      // A bare `-p 8080:8080` publishes on 0.0.0.0 and would expose the Worker
      // to the LAN.
      assert.doesNotMatch(exec, /(?:-p|--publish)\s+0\.0\.0\.0:/, "no wildcard publication");
      assert.doesNotMatch(exec, /(?:-p|--publish)\s+\d+:\d+/, "no implicit all-interfaces publication");
    });

    it("takes the published port from configuration, never a hard-coded guess", () => {
      const exec = values(netnsUnit, "ExecStart").join("\n");
      assert.match(exec, /\$\{VIDEOFETCH_WORKER_PORT\}/);
      assert.ok(
        values(netnsUnit, "EnvironmentFile").some((f) => f.includes("media-egress.env")),
        "the port arrives from the deployment configuration file",
      );
    });

    it("keeps the holder unprivileged and unable to alter its own policy", () => {
      const exec = values(netnsUnit, "ExecStart").join("\n");
      assert.match(exec, /--cap-drop=ALL\b/);
      assert.match(exec, /--security-opt\s+no-new-privileges\b/);

      // The namespace OWNER must not be able to rewrite the firewall that
      // constrains the namespace. That authority stays with VM root, outside.
      assert.doesNotMatch(exec, /NET_ADMIN/i, "the holder must not retain NET_ADMIN to stay alive");
      assert.doesNotMatch(exec, /SYS_ADMIN/i);
      assert.doesNotMatch(exec, /--privileged\b/);
      assert.doesNotMatch(exec, /--network\s+host\b/);
      assert.doesNotMatch(exec, /docker\.sock/);
      assert.doesNotMatch(exec, /--cap-add/);
    });

    it("gives the holder no filesystem or credential authority", () => {
      const exec = values(netnsUnit, "ExecStart").join("\n");
      assert.match(exec, /--read-only\b/);
      assert.doesNotMatch(exec, /(^|\s)(-v|--volume)\s/, "the holder mounts nothing");
      assert.doesNotMatch(exec, /(^|\s)(-e|--env|--env-file)\s/, "the holder receives no environment");

      for (const forbidden of [
        "R2_ACCOUNT_ID",
        "R2_BUCKET",
        "R2_WRITER",
        "R2_BROKER_PARENT",
        "R2_SIGNER",
        "WORKER_CONTROL_SECRET",
        "CLOUDFLARE",
        "TUNNEL",
      ]) {
        assert.equal(
          netnsUnit.join("\n").includes(forbidden),
          false,
          `the namespace holder must never carry ${forbidden}`,
        );
      }
    });

    it("runs the holder as a non-root numeric identity", () => {
      const exec = values(netnsUnit, "ExecStart").join("\n");
      const user = /--user\s+(\S+)/.exec(exec)?.[1];
      assert.ok(user, "an explicit --user is required");
      assert.doesNotMatch(user!, /^(0(:|$)|root)/, "the holder must not run as root");
    });

    it("builds the holder from committed, reproducible source", () => {
      // The prototype depended on `alpine:vf`, a local-only image that existed
      // on one VM and could not be rebuilt or audited.
      assert.doesNotMatch(
        values(netnsUnit, "ExecStart").join("\n"),
        /\balpine:vf\b/,
        "the opaque local prototype image must not be reintroduced",
      );

      assert.ok(holderDockerfile.length > 0, "a committed Dockerfile must exist");

      const fromLines = holderDockerfile
        .split("\n")
        .filter((line) => /^\s*FROM\s/i.test(line))
        .map((line) => line.trim());
      assert.ok(fromLines.length >= 1);

      // No floating tags anywhere.
      for (const from of fromLines) {
        assert.doesNotMatch(from, /:latest\b/, `no floating tag: ${from}`);
        // `FROM scratch` is the empty image, not a tag that can float.
        if (/^FROM\s+scratch\b/i.test(from)) continue;
        assert.doesNotMatch(from, /^FROM\s+[\w./-]+\s*$/i, `an unversioned base is a floating tag: ${from}`);
      }

      // The base is an explicit version (or a digest), and is overridable so a
      // deployment can pin harder.
      assert.match(holderDockerfile, /ARG\s+HOLDER_BUILD_BASE=\S+:\d+\.\d+/, "explicit base version");
      assert.match(holderDockerfile, /--build-arg\s+HOLDER_BUILD_BASE=\S*@sha256:/, "documents digest pinning");

      // The shipped stage carries nothing but the binary.
      assert.match(fromLines[fromLines.length - 1], /^FROM\s+scratch\b/i, "final stage is FROM scratch");
      assert.match(holderDockerfile, /COPY\s+--from=build\s+\/holder\s+\/holder/);
    });

    it("makes no x86-only assumption, because the target is an M1 Lima VM", () => {
      for (const forbidden of [/amd64/i, /x86[_-]?64/i, /linux\/386/i]) {
        assert.doesNotMatch(holderDockerfile, forbidden, `arm64 target: ${forbidden} is not portable`);
      }
      assert.match(holderDockerfile, /linux\/arm64/, "arm64 is named explicitly");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("Worker dependency reconciliation", () => {
    it("KEEPS the broker boundary exactly as it was", () => {
      // Reconciliation must not quietly drop the boundary it is being merged
      // with. These four are the WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001
      // contract and are re-asserted here as well as in the broker suite.
      assert.ok(tokens(workerUnit, "Requires").includes("videofetch-r2-broker.service"));
      assert.ok(tokens(workerUnit, "After").includes("videofetch-r2-broker.service"));
      assert.ok(tokens(workerUnit, "BindsTo").includes("videofetch-r2-broker.service"));
      assert.match(
        values(workerUnit, "ExecStartPre").join("\n"),
        /vf-r2-broker-gid-verify[^\n]*\$\{VIDEOFETCH_BROKER_GID\}/,
      );
    });

    it("requires ALL THREE safe-egress units, not just the namespace", () => {
      const needed = [
        "videofetch-media-netns.service",
        "videofetch-egress-policy.service",
        "videofetch-egress-watchdog.service",
      ];
      for (const unit of needed) {
        assert.ok(tokens(workerUnit, "Requires").includes(unit), `Requires= must name ${unit}`);
        assert.ok(tokens(workerUnit, "After").includes(unit), `After= must name ${unit}`);
        assert.ok(tokens(workerUnit, "BindsTo").includes(unit), `BindsTo= must name ${unit}`);
      }
    });

    it("stops the Worker when the watchdog dies, so it is never unmonitored", () => {
      // The prototype's watchdog was `After=vf-worker.service` and nothing
      // depended on it: a dead watchdog left the Worker running unobserved.
      assert.ok(
        tokens(workerUnit, "BindsTo").includes("videofetch-egress-watchdog.service"),
        "BindsTo= on the watchdog is what makes watchdog failure fail closed",
      );
      assert.deepEqual(
        values(watchdogUnit, "Restart"),
        ["no"],
        "a breached watchdog must not restart itself into an open boundary",
      );
    });

    it("gates the Worker on a FATAL pre-start verification", () => {
      const pre = values(workerUnit, "ExecStartPre");
      const gate = pre.find((v) => v.includes("vf-egress-policy-verify"));
      assert.ok(gate, "a safe-egress pre-start gate is required");
      // A leading '-' would make systemd ignore its failure.
      assert.ok(!gate!.trimStart().startsWith("-"), "the egress gate's failure must be fatal");
    });

    it("has no fallback network", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      const networks = exec.match(/--network\s+\S+/g) ?? [];
      assert.deepEqual(networks, ["--network container:videofetch-media-netns"]);
      assert.doesNotMatch(exec, /--network\s+(host|bridge|none|default)\b/);
    });

    it("creates no dependency cycle", () => {
      // Nothing the Worker depends on may depend back on the Worker.
      for (const [name, unit] of [
        ["media-netns", netnsUnit],
        ["egress-policy", policyUnit],
        ["egress-watchdog", watchdogUnit],
      ] as const) {
        for (const key of ["Requires", "BindsTo", "After", "Wants", "PartOf", "Before"]) {
          for (const value of values(unit, key)) {
            assert.equal(
              value.includes("videofetch-worker"),
              false,
              `${name}'s ${key}= must not reference the Worker unit`,
            );
          }
        }
      }
    });

    it("orders the boundary behind the container runtime", () => {
      assert.ok(tokens(netnsUnit, "After").includes("docker.service"));
      assert.ok(tokens(netnsUnit, "Requires").includes("docker.service"));
      assert.ok(tokens(policyUnit, "After").includes("videofetch-media-netns.service"));
      assert.ok(tokens(policyUnit, "BindsTo").includes("videofetch-media-netns.service"));
      assert.ok(tokens(watchdogUnit, "After").includes("videofetch-egress-policy.service"));
    });

    it("keeps the fingerprints in /run, tied to the policy unit's lifetime", () => {
      assert.deepEqual(values(policyUnit, "RuntimeDirectory"), ["videofetch-egress"]);
      // Never /etc, and never committed.
      assert.doesNotMatch(policyUnit.join("\n"), /\/etc\/videofetch\/policy\.expected/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("Worker hardening survives reconciliation", () => {
    it("retains every current container invariant", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      assert.match(exec, /--read-only\b/);
      assert.match(exec, /--tmpfs\s+\/tmp\/videofetch:rw,noexec,nosuid,size=2g\b/);
      assert.match(exec, /--volume\s+\/var\/lib\/videofetch:\/var\/lib\/videofetch:rw\b/);
      assert.match(exec, /--volume\s+\/run\/videofetch-r2-broker:\/run\/videofetch-r2-broker:ro\b/);
      assert.match(exec, /--group-add\s+\$\{VIDEOFETCH_BROKER_GID\}/);
      assert.match(exec, /--cap-drop=ALL\b/);
      assert.match(exec, /--security-opt\s+no-new-privileges\b/);
    });

    it("acquires no privilege from the safe-egress merge", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      assert.doesNotMatch(exec, /--privileged\b/);
      assert.doesNotMatch(exec, /NET_ADMIN/i);
      assert.doesNotMatch(exec, /SYS_ADMIN/i);
      assert.doesNotMatch(exec, /--cap-add/);
      assert.doesNotMatch(exec, /docker\.sock/);
    });

    it("imports no prototype regression", () => {
      // The VM's vf-worker.service is the pre-delegation model. None of its
      // distinguishing marks may appear here.
      for (const forbidden of [
        "/var/lib/videofetch-proto",
        "videofetch-proto-fake",
        "R2_WRITER_ACCESS_KEY_ID",
        "R2_WRITER_SECRET_ACCESS_KEY",
        "R2_WRITER_SESSION_TOKEN",
        "R2_BROKER_PARENT_ACCESS_KEY_ID",
        "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
        "R2_SIGNER_ACCESS_KEY_ID",
        "R2_SIGNER_SECRET_ACCESS_KEY",
        "videofetch-worker:proto",
        "vf-anchor",
        "vf-policy-breach.target",
      ]) {
        assert.equal(
          workerSource.includes(forbidden),
          false,
          `the reconciled Worker unit must not carry the prototype's ${forbidden}`,
        );
      }
    });

    it("keeps yt-dlp disabled", () => {
      for (const truthy of ["true", "1", "yes"]) {
        assert.doesNotMatch(
          workerUnit.join("\n"),
          new RegExp(`YTDLP_NETWORK_ISOLATED\\s*=\\s*["']?${truthy}["']?(\\s|$)`, "i"),
          `YTDLP_NETWORK_ISOLATED must never be set to ${truthy}`,
        );
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("nftables policy template", () => {
    it("denies every required IPv4 class", () => {
      const set = /set\s+forbidden_v4\s*\{([\s\S]*?)\}/.exec(nftTemplate)?.[1];
      assert.ok(set, "a forbidden_v4 set is required");
      for (const cidr of REQUIRED_V4) {
        assert.ok(set!.includes(cidr), `IPv4 deny class ${cidr} is missing`);
      }
    });

    it("denies every required IPv6 class", () => {
      const set = /set\s+forbidden_v6\s*\{([\s\S]*?)\}/.exec(nftTemplate)?.[1];
      assert.ok(set, "a forbidden_v6 set is required");
      for (const { label, pattern } of REQUIRED_V6) {
        assert.match(set!, pattern, `IPv6 deny class ${label} is not represented`);
      }
    });

    it("denies the broadcast address explicitly", () => {
      // 255.255.255.255/32 is inside 240.0.0.0/4 and nftables interval sets
      // reject overlapping elements, so it needs its own rule and counter.
      assert.match(nftTemplate, /ip\s+daddr\s+255\.255\.255\.255\s+counter\s+reject/);
    });

    it("is default-drop", () => {
      assert.match(nftTemplate, /type filter hook output priority filter;\s*policy drop;/);
      assert.doesNotMatch(nftTemplate, /policy\s+accept\s*;/);
    });

    it("permits only public TCP 80/443 for ordinary media egress", () => {
      assert.match(nftTemplate, /tcp dport \{ 80, 443 \} counter accept/);

      // The public accept must sit BELOW the deny rules, or a forbidden
      // destination on port 443 would be accepted before it is ever denied.
      const denyIndex = nftTemplate.indexOf("@forbidden_v4");
      const acceptIndex = nftTemplate.indexOf("tcp dport { 80, 443 }");
      assert.ok(denyIndex > 0 && acceptIndex > denyIndex, "deny rules must precede the public accept");
    });

    it("hard-codes NO DNS resolver, and fails loudly if substitution is skipped", () => {
      // The prototype baked in 172.17.0.1 — one host's bridge address.
      assert.doesNotMatch(
        nftTemplate,
        /^\s*ip6?\s+daddr\s+[0-9a-fA-F.:]+\s+(udp|tcp)\s+dport\s+53/m,
        "no resolver address may be committed in the policy source",
      );

      const marker = "@@VIDEOFETCH_DESIGNATED_DNS@@";
      assert.ok(
        nftTemplate.split("\n").some((line) => line.trim() === marker),
        "the template must carry the substitution marker on its own line",
      );
      // Not commented out: an unsubstituted marker must break `nft -f` rather
      // than silently install a policy with no DNS exception.
      assert.ok(
        !nftTemplate.split("\n").some((line) => line.trim() === `# ${marker}`),
        "the marker must be invalid nft syntax, not a comment",
      );
    });

    it("allows no broad private range and no arbitrary UDP", () => {
      const acceptLines = nftTemplate
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("#") && /\baccept\b/.test(line));

      for (const line of acceptLines) {
        assert.doesNotMatch(line, /10\.0\.0\.0\/8|192\.168\.|172\.16\.0\.0\/12|127\.0\.0\.0\/8/, `broad private allow: ${line}`);
        // The only UDP permitted is the rendered DNS exception, which is not
        // in the committed source at all.
        assert.doesNotMatch(line, /\budp\b(?!.*dport 53)/, `arbitrary UDP allow: ${line}`);
      }

      // The committed source accepts exactly two things; DNS is rendered in.
      assert.equal(acceptLines.length, 2, `expected 2 committed accepts, got: ${acceptLines.join(" | ")}`);
    });

    it("ships an environment template with no value filled in", () => {
      for (const line of envTemplate.split("\n")) {
        if (/^\s*#/.test(line) || line.trim() === "") continue;
        assert.match(line, /^[A-Z0-9_]+=$/, `template value must be empty: ${line}`);
      }
      assert.match(envTemplate, /VIDEOFETCH_MEDIA_DNS_FLAGS=/);
      assert.match(envTemplate, /VIDEOFETCH_WORKER_PORT=/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("verifier and watchdog source contract", () => {
    it("never repairs, reloads or re-installs the policy", () => {
      for (const [name, source] of [
        ["verifier", verifySource],
        ["watchdog", watchdogScript],
      ] as const) {
        assert.doesNotMatch(source, /nft\s+-f\b/, `${name} must not load a ruleset`);
        assert.doesNotMatch(source, /\bnft\b[^\n]*\b(add|delete|flush|insert|replace)\b/, `${name} must not mutate nftables`);
        assert.doesNotMatch(source, /\bip\b[^\n]*\broute\s+(add|del|replace)\b/, `${name} must not mutate routes`);
      }
      // The verifier must not invoke the installer at all.
      assert.doesNotMatch(verifySource, /vf-egress-policy-install/);
    });

    it("stops the Worker on breach rather than only logging", () => {
      assert.match(watchdogScript, /systemctl[^\n]*stop[^\n]*WORKER_UNIT|stop"?\s+"\$WORKER_UNIT"/);
      assert.match(watchdogScript, /videofetch-worker\.service/);
      // And exits nonzero, so BindsTo= propagates even if systemctl failed.
      assert.match(watchdogScript, /exit 1/);
    });

    it("does not reproduce the prototype's dangling breach target", () => {
      for (const source of [watchdogScript, watchdogSource, verifySource]) {
        assert.doesNotMatch(
          executableLines(source),
          /vf-policy-breach\.target/,
          "the prototype invoked a target that did not exist; nothing may execute that call",
        );
      }
      // It must still be EXPLAINED, so nobody re-adds it believing it worked.
      assert.match(watchdogSource, /vf-policy-breach\.target/);
    });

    it("watches routes as well as nftables", () => {
      const watchdogExecutable = executableLines(watchdogScript);
      assert.match(watchdogExecutable, /\$VF_IP"?\s+monitor[^\n]*route/, "route events must be watched");
      assert.match(watchdogExecutable, /\$VF_NFT"?\s+monitor/, "nftables events must be watched");
      assert.match(watchdogScript, /BACKSTOP_SECONDS/, "a bounded periodic backstop is required");
    });

    it("verifies IPv4 routes, IPv6 routes AND policy-routing rules", async () => {
      // Canonicalization lives in the shared library so the installer and the
      // verifier cannot drift apart, so the contract spans both files.
      const lib = await readFile(LIB_SCRIPT, "utf8");
      const combined = executableLines(verifySource) + "\n" + executableLines(lib);

      assert.match(combined, /-4 route show/, "IPv4 routes must be inspected");
      assert.match(combined, /-6 route show/, "IPv6 routes must be inspected");
      assert.match(combined, /-4 rule show/, "IPv4 policy routing rules must be inspected");
      assert.match(combined, /-6 rule show/, "IPv6 policy routing rules must be inspected");
      assert.match(executableLines(verifySource), /VF_ROUTES_FINGERPRINT/);
    });

    it("keeps runtime fingerprints under /run and out of Git", async () => {
      const lib = await readFile(LIB_SCRIPT, "utf8");
      assert.match(lib, /VF_RUNDIR="\$\{VF_RUNDIR:-\/run\/videofetch-egress\}"/);
      assert.match(lib, /VF_POLICY_FINGERPRINT="\$VF_RUNDIR\//);
      assert.match(lib, /VF_ROUTES_FINGERPRINT="\$VF_RUNDIR\//);

      const tracked = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
      assert.equal(tracked.status, 0);
      for (const path of tracked.stdout.split("\n")) {
        assert.doesNotMatch(path, /policy\.expected\.sha256|routes\.expected\.sha256/, `${path} must never be committed`);
      }
    });

    it("hard-codes no Lima, Docker or link-local constant", () => {
      const sources = [verifySource, watchdogScript, installScript, multicastScript, nftTemplate];
      for (const source of sources) {
        const executable = source
          .split("\n")
          .filter((line) => !/^\s*#/.test(line))
          .join("\n");
        assert.doesNotMatch(executable, /172\.17\.\d+\.\d+/, "no Docker bridge address");
        assert.doesNotMatch(executable, /\bfe80::[0-9a-f:]+\b/i, "no host link-local address");
        assert.doesNotMatch(executable, /\beth0\b/, "no fixed interface name");
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("multicast attribution helper (SAFE-EGRESS-MULTICAST-ATTRIBUTION-001)", () => {
    it("is unreachable from the production startup path", () => {
      for (const [name, unit] of [
        ["worker", workerSource],
        ["media-netns", netnsSource],
        ["egress-policy", policyUnit.join("\n")],
        ["egress-watchdog", watchdogSource],
      ] as const) {
        assert.equal(
          executableLines(unit).includes("multicast-route-test"),
          false,
          `${name}.service must not reference the acceptance helper`,
        );
      }
      // Comments in the installer DESCRIBE the acceptance path deliberately;
      // what matters is that nothing executes it.
      assert.equal(executableLines(installScript).includes("multicast-route-test"), false);
      assert.equal(executableLines(watchdogScript).includes("multicast-route-test"), false);
    });

    it("requires an explicit acceptance acknowledgement AND root", () => {
      assert.match(multicastScript, /--phase9-acceptance/);
      assert.match(multicastScript, /id -u/);
    });

    it("cleans up from a trap that also runs on failure", () => {
      assert.match(multicastScript, /trap cleanup EXIT INT TERM/);
      // The trap must be installed BEFORE the first route is added.
      const trapIndex = multicastScript.indexOf("trap cleanup EXIT");
      const addIndex = multicastScript.indexOf("route add");
      assert.ok(trapIndex > 0 && addIndex > trapIndex, "the trap must precede any route mutation");
      assert.match(multicastScript, /route del/, "cleanup must remove what it added");
    });

    it("adds narrow test routes inside the denied ranges, and never weakens policy", () => {
      assert.match(multicastScript, /VF_MULTICAST_V4_TEST:-224\.0\.2\.1\/32/, "a narrow IPv4 test destination");
      assert.match(multicastScript, /VF_MULTICAST_V6_TEST:-ff0e::1\/128/, "a narrow IPv6 test destination");
      assert.doesNotMatch(multicastScript, /nft\s+-f\b/, "it must never load a ruleset");
      assert.doesNotMatch(multicastScript, /forbidden_v4|forbidden_v6/, "it must never touch the deny sets");
      // It re-baselines ROUTES only, never the policy fingerprint.
      assert.match(multicastScript, /--routes-baseline-only/);
    });

    it("refuses to run outside the enforced media namespace", () => {
      assert.match(multicastScript, /list table inet videofetch_egress/);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// BEHAVIOURAL: run the real scripts against recorded fixtures.
// ──────────────────────────────────────────────────────────────────────────

const CANONICAL_RULESET = `table inet videofetch_egress {
\tset forbidden_v4 {
\t\ttype ipv4_addr
\t\tflags interval
\t\telements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
\t\t\t     169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
\t\t\t     192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
\t\t\t     224.0.0.0/4, 240.0.0.0/4 }
\t}

\tset forbidden_v6 {
\t\ttype ipv6_addr
\t\tflags interval
\t\telements = { ::/96, ::ffff:0.0.0.0/96, 64:ff9b::/32, 2001::/32,
\t\t\t     2002::/16, fc00::/7, fe80::/10, ff00::/8 }
\t}

\tchain output {
\t\ttype filter hook output priority filter; policy drop;
\t\tct state established,related counter packets 12 bytes 900 accept comment "established"
\t\tip daddr 10.11.12.13 udp dport 53 counter packets 3 bytes 200 accept comment "designated-dns-udp"
\t\tip daddr 10.11.12.13 tcp dport 53 counter packets 0 bytes 0 accept comment "designated-dns-tcp"
\t\tip daddr 255.255.255.255 counter packets 0 bytes 0 reject with icmp type admin-prohibited comment "deny-v4-broadcast"
\t\tip daddr @forbidden_v4 counter packets 5 bytes 300 reject with icmp type admin-prohibited comment "deny-v4"
\t\tip6 daddr @forbidden_v6 counter packets 1 bytes 80 reject with icmpv6 type admin-prohibited comment "deny-v6"
\t\ttcp dport { 80, 443 } counter packets 44 bytes 5000 accept comment "public-http"
\t\tcounter packets 0 bytes 0 comment "fallthrough-drop"
\t}
}
`;

const V4_ROUTES = "default via 10.11.12.1 dev vfnet0 \n10.11.12.0/24 dev vfnet0 proto kernel scope link src 10.11.12.9 \n";
const V6_ROUTES = "fe80::/64 dev vfnet0 proto kernel metric 256 pref medium\n";
const V4_RULES = "0:\tfrom all lookup local\n32766:\tfrom all lookup main\n32767:\tfrom all lookup default\n";
const V6_RULES = "0:\tfrom all lookup local\n32766:\tfrom all lookup main\n";

describe("safe-egress verifier behaviour", () => {
  let sandbox: string;
  let env: NodeJS.ProcessEnv;

  const write = (name: string, body: string) => writeFile(join(sandbox, name), body);

  /** Re-derives the baselines exactly as the installer would. */
  function baseline(): void {
    const script = `. "$VF_EGRESS_LIB"
vf_canonical_ruleset 4242 | vf_sha256 > "$VF_RUNDIR/policy.expected.sha256"
vf_canonical_routes  4242 | vf_sha256 > "$VF_RUNDIR/routes.expected.sha256"`;
    const result = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `baseline failed: ${result.stderr}`);
  }

  function verify(): { status: number | null; stderr: string } {
    const result = spawnSync("bash", [VERIFY_SCRIPT], { env, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  }

  /**
   * Runs the watchdog for real, mutating the fixture partway through.
   *
   * The tamper is backgrounded INSIDE the shell rather than scheduled with a
   * timer here: spawnSync blocks this process's event loop, so a setTimeout
   * would not fire until the watchdog had already exited.
   */
  function runWatchdogWithTamper(tamperCommand: string) {
    return spawnSync(
      "bash",
      ["-c", `( sleep 1.5; ${tamperCommand} ) & exec bash "$1"`, "_", WATCHDOG_SCRIPT],
      { env, encoding: "utf8", timeout: 60_000 },
    );
  }

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "vf-egress-"));
    const bin = join(sandbox, "bin");
    const run = join(sandbox, "run");
    await mkdir(bin);
    await mkdir(run);

    // Stub tools. Each reads a fixture file, so a test can mutate the
    // "namespace" by rewriting a file.
    const stubs: Record<string, string> = {
      docker: `#!/bin/bash\n[ "$1" = inspect ] && { cat "$VT/pid"; exit 0; }\nexit 1\n`,
      // Drops `-t <pid> -n` and execs the rest, standing in for namespace entry.
      nsenter: `#!/bin/bash\nshift 3\nexec "$@"\n`,
      nft: `#!/bin/bash\n[ "$1" = list ] && [ "$2" = ruleset ] && { cat "$VT/ruleset"; exit 0; }\n[ "$1" = monitor ] && { while :; do sleep 1; done; }\nexit 1\n`,
      ip: `#!/bin/bash\ncase "$1 $2 $3" in\n  "-4 route show") cat "$VT/v4route" ;;\n  "-6 route show") cat "$VT/v6route" ;;\n  "-4 rule show") cat "$VT/v4rule" ;;\n  "-6 rule show") cat "$VT/v6rule" ;;\n  "monitor route link") while :; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n`,
      // macOS has no sha256sum; both install and verify use this same stub, so
      // the two sides stay consistent whichever tool exists.
      sha256sum: `#!/bin/sh\nif command -v shasum >/dev/null 2>&1; then exec shasum -a 256; fi\nexec /usr/bin/sha256sum\n`,
      systemctl: `#!/bin/bash\necho "systemctl $*" >> "$VT/systemctl.log"\n`,
      "systemd-notify": `#!/bin/bash\necho "notify $*" >> "$VT/notify.log"\n`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(bin, name);
      await writeFile(path, body);
      await chmod(path, 0o755);
    }

    await write("pid", "4242\n");
    await write("ruleset", CANONICAL_RULESET);
    await write("v4route", V4_ROUTES);
    await write("v6route", V6_ROUTES);
    await write("v4rule", V4_RULES);
    await write("v6rule", V6_RULES);
    await write("media-egress.env", 'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 10.11.12.13"\n');

    env = {
      ...process.env,
      VT: sandbox,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      VF_EGRESS_LIB: LIB_SCRIPT,
      VF_CONFIG_FILE: join(sandbox, "media-egress.env"),
      VF_RUNDIR: run,
      VF_NFT: join(bin, "nft"),
      VF_IP: join(bin, "ip"),
      VF_DOCKER: join(bin, "docker"),
      VF_NSENTER: join(bin, "nsenter"),
      VF_EGRESS_VERIFY: VERIFY_SCRIPT,
      VF_SYSTEMCTL: join(bin, "systemctl"),
      VF_SYSTEMD_NOTIFY: join(bin, "systemd-notify"),
      VF_EGRESS_BACKSTOP_SECONDS: "1",
    };

    baseline();
  });

  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("passes on the canonical boundary", () => {
    const { status, stderr } = verify();
    assert.equal(status, 0, stderr);
  });

  it("ignores counter-only noise, which is not a policy change", async () => {
    // Packet and byte counters move constantly. If they failed verification,
    // the boundary would be unusable and someone would disable the check.
    await write(
      "ruleset",
      CANONICAL_RULESET.replace("packets 12 bytes 900", "packets 999999 bytes 88888888").replace(
        "packets 44 bytes 5000",
        "packets 7 bytes 7",
      ),
    );
    assert.equal(verify().status, 0);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when a deny class is removed", async () => {
    await write("ruleset", CANONICAL_RULESET.replace("224.0.0.0/4, ", ""));
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /224\.0\.0\.0\/4 missing/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when an IPv6 deny class is removed", async () => {
    await write("ruleset", CANONICAL_RULESET.replace("::/96, ::ffff:0.0.0.0/96", "::ffff:0.0.0.0/96"));
    assert.equal(verify().status, 1);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when an allow is broadened", async () => {
    await write("ruleset", CANONICAL_RULESET.replace("{ 80, 443 }", "{ 80, 443, 8080 }"));
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /allow shape mismatch/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when an unexpected allow rule is ADDED", async () => {
    await write(
      "ruleset",
      CANONICAL_RULESET.replace(
        '\t\ttcp dport { 80, 443 }',
        '\t\tip daddr 10.0.0.0/8 counter packets 0 bytes 0 accept comment "backdoor"\n\t\ttcp dport { 80, 443 }',
      ),
    );
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /allow shape mismatch/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when the chain stops being default-drop", async () => {
    await write("ruleset", CANONICAL_RULESET.replace("policy drop;", "policy accept;"));
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /not default-drop/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when a second table could DNAT around the deny set", async () => {
    await write(
      "ruleset",
      `${CANONICAL_RULESET}table ip sneaky {\n\tchain out {\n\t\ttype nat hook output priority dstnat; policy accept;\n\t\tip daddr 1.2.3.4 counter packets 0 bytes 0 dnat to 10.0.0.5\n\t}\n}\n`,
    );
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /exactly 1 nftables table/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when rule ORDER changes, even with the same rules", async () => {
    // Moving the DNS accept below the deny rules would break resolution for a
    // resolver inside a denied class. Caught by the fingerprint.
    const lines = CANONICAL_RULESET.split("\n");
    const dnsUdp = lines.findIndex((l) => l.includes("designated-dns-udp"));
    const [moved] = lines.splice(dnsUdp, 1);
    const publicIndex = lines.findIndex((l) => l.includes("public-http"));
    lines.splice(publicIndex, 0, moved);
    await write("ruleset", lines.join("\n"));
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /fingerprint MUTATED/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("fails when the namespace is absent", async () => {
    await write("pid", "0\n");
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /namespace holder absent/);
    await write("pid", "4242\n");
  });

  it("fails when the policy fingerprint is missing", async () => {
    await rm(join(sandbox, "run", "policy.expected.sha256"));
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /policy fingerprint missing/);
    baseline();
  });

  it("fails when a route is added after install", async () => {
    await write("v4route", `${V4_ROUTES}10.9.0.0/16 via 10.11.12.9 dev vfnet0 \n`);
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /ROUTE TABLE mutated/);
    await write("v4route", V4_ROUTES);
  });

  it("fails when a policy-routing rule is injected", async () => {
    await write("v4rule", "0:\tfrom all lookup local\n100:\tfrom all lookup 100\n32766:\tfrom all lookup main\n");
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /non-default priority 100/);
    await write("v4rule", V4_RULES);
  });

  it("fails when the resolver configuration is a RANGE rather than an address", async () => {
    // safe-egress.md permits an exception for an exact resolver address, never
    // for a private network.
    await write("media-egress.env", 'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 10.11.12.0/24"\n');
    const { status, stderr } = verify();
    assert.equal(status, 1);
    assert.match(stderr, /resolver configuration is invalid/);
    await write("media-egress.env", 'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 10.11.12.13"\n');
  });

  it("fails when no resolver is configured at all", async () => {
    await write("media-egress.env", "VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS=\n");
    assert.equal(verify().status, 1);
    await write("media-egress.env", 'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 10.11.12.13"\n');
  });

  it("passes again once everything is restored", () => {
    assert.equal(verify().status, 0);
  });

  // ── watchdog ───────────────────────────────────────────────────────────

  it("watchdog stops the Worker and exits nonzero when the policy is tampered with", async () => {
    await write("ruleset", CANONICAL_RULESET);
    await write("ruleset.tampered", CANONICAL_RULESET.replace("{ 80, 443 }", "{ 80, 443, 9999 }"));
    await rm(join(sandbox, "systemctl.log"), { force: true });

    const result = runWatchdogWithTamper('cp "$VT/ruleset.tampered" "$VT/ruleset"');

    assert.equal(result.status, 1, "a breach must exit nonzero so BindsTo= propagates the stop");
    assert.match(result.stderr, /BREACH/);

    const log = await readFile(join(sandbox, "systemctl.log"), "utf8");
    assert.match(log, /stop videofetch-worker\.service/, "the Worker must be stopped, not merely logged about");

    await write("ruleset", CANONICAL_RULESET);
  });

  it("watchdog refuses to arm when the boundary is already invalid", async () => {
    await write("pid", "0\n");
    const result = spawnSync("bash", [WATCHDOG_SCRIPT], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BREACH/);
    // Readiness must never be reported before the boundary is established.
    const notify = spawnSync("cat", [join(sandbox, "notify.log")], { encoding: "utf8" }).stdout ?? "";
    assert.doesNotMatch(notify.split("\n").slice(-1)[0] ?? "", /--ready/);
    await write("pid", "4242\n");
  });

  it("watchdog breaches when the route table changes at runtime", async () => {
    await rm(join(sandbox, "systemctl.log"), { force: true });
    await write("v4route.tampered", `${V4_ROUTES}192.168.7.0/24 via 10.11.12.9 dev vfnet0 \n`);

    const result = runWatchdogWithTamper('cp "$VT/v4route.tampered" "$VT/v4route"');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BREACH/);
    await write("v4route", V4_ROUTES);
  });

  it("multicast helper refuses to run without explicit acceptance intent", () => {
    const result = spawnSync("bash", [MULTICAST_SCRIPT], { env, encoding: "utf8" });
    assert.equal(result.status, 2, "it must refuse, not proceed");
    assert.match(result.stderr, /refusing to run/);
    assert.match(result.stderr, /--phase9-acceptance/);
  });

  it("multicast helper rejects unknown arguments rather than guessing", () => {
    const result = spawnSync("bash", [MULTICAST_SCRIPT, "--yolo"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
  });
});
