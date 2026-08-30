import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { spawnSync, spawn } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
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
const HOLDER_SOURCE = join(DEPLOY, "media-netns", "holder.c");

const DNS_UNIT = join(SYSTEMD, "videofetch-media-dns.service");
const RESOLVED_DROPIN = join(SYSTEMD, "resolved.conf.d", "10-videofetch-media-dns.conf.example");
const DNS_CHECK_SCRIPT = join(BIN, "vf-media-dns-check");

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

/**
 * The option list of a `--tmpfs <target>:<options>` flag, split into its
 * individual options.
 *
 * Order-insensitive by construction: callers assert over the SET, so
 * re-ordering the mount options cannot fail a test, while dropping one of them
 * must. The previous single-regex assertion could only compare one exact
 * spelling, which is how it came to certify a mount the Worker could not write
 * (WORKER-TEMP-TMPFS-OWNERSHIP-001).
 */
function tmpfsOptions(exec: string, target: string): string[] {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = [...exec.matchAll(new RegExp(`--tmpfs\\s+${escaped}:(\\S+)`, "g"))];
  assert.equal(found.length, 1, `expected exactly one --tmpfs mount of ${target}`);
  return found[0]![1]!.split(",").filter(Boolean);
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
  let holderSource: string;
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
    holderSource = await readFile(HOLDER_SOURCE, "utf8");
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

      // CORRECTION 01. The COMMITTED DEFAULT must be immutable on its own,
      // without the operator remembering to override anything. A tag — even
      // `alpine:3.22.5` — is mutable: Alpine republishes patch tags when a
      // base package is rebuilt, so only the digest actually pins the build.
      const baseArg = /ARG\s+HOLDER_BUILD_BASE=(\S+)/.exec(holderDockerfile)?.[1];
      assert.ok(baseArg, "HOLDER_BUILD_BASE must have a committed default");
      assert.match(baseArg!, /@sha256:[0-9a-f]{64}$/, "the default must be pinned by digest");
      assert.doesNotMatch(baseArg!, /:latest/, "never latest");
      // And not a bare floating major/minor tag with no digest attached.
      assert.doesNotMatch(baseArg!, /^[\w./-]+:\d+(\.\d+)?$/, "a bare major/minor tag is not immutable");
      // The human-readable half should still name an exact patch release.
      assert.match(baseArg!, /:\d+\.\d+\.\d+@sha256:/, "keep the exact patch tag beside the digest");

      // The shipped stage carries nothing but the binary.
      assert.match(fromLines[fromLines.length - 1], /^FROM\s+scratch\b/i, "final stage is FROM scratch");
      assert.match(holderDockerfile, /COPY\s+--from=build\s+\/holder\s+\/holder/);
    });

    it("ships a runtime stage containing only the holder binary", () => {
      // Everything after the final FROM is what actually ships. It must be one
      // COPY and nothing else that adds content: no package install, no shell,
      // no CA bundle, no credential, no second artefact.
      const lines = holderDockerfile.split("\n").map((l) => l.trim());
      const finalFrom = lines.findIndex((l) => /^FROM\s+scratch\b/i.test(l));
      assert.ok(finalFrom >= 0);
      const runtime = lines
        .slice(finalFrom + 1)
        .filter((l) => l.length > 0 && !l.startsWith("#"));

      const copies = runtime.filter((l) => /^COPY\s/i.test(l));
      assert.deepEqual(
        copies,
        ["COPY --from=build /holder /holder"],
        "exactly one artefact may be copied into the runtime image",
      );

      for (const line of runtime) {
        assert.doesNotMatch(line, /^(RUN|ADD)\s/i, `the runtime stage must not ${line}`);
        assert.doesNotMatch(line, /\b(apk|apt-get|yum|dnf|pip)\b/i, "no package manager in the runtime stage");
        assert.doesNotMatch(line, /\b(sh|bash|busybox)\b/, "no shell in the runtime stage");
      }

      // No credential-shaped declaration anywhere in the image.
      for (const forbidden of ["R2_", "WORKER_CONTROL", "CLOUDFLARE", "TOKEN", "SECRET"]) {
        const declarations = holderDockerfile
          .split("\n")
          .filter((l) => /^\s*(ENV|ARG)\s/i.test(l))
          .join("\n");
        assert.equal(declarations.includes(forbidden), false, `no ${forbidden} in the holder image`);
      }
    });

    it("runs the holder as a numeric non-root identity in the image too", () => {
      const user = /^\s*USER\s+(\S+)/im.exec(holderDockerfile)?.[1];
      assert.ok(user, "the image must declare USER");
      assert.match(user!, /^\d+(:\d+)?$/, "numeric: a scratch image has no /etc/passwd to resolve a name");
      assert.doesNotMatch(user!, /^0(:|$)/, "not uid 0");
    });

    it("declares a standard header for every standard symbol it uses", () => {
      // PHASE-8B-FIRST-DEPLOYMENT-DEFECTS-001. The first real build of this
      // image failed at `gcc -Wall -Wextra -Werror` with "'NULL' undeclared":
      // holder.c used NULL while including only <signal.h>. The C standard
      // defines NULL in <stddef.h> and a handful of headers that include it;
      // glibc leaks it through <signal.h>, musl does not, so the omission was
      // invisible until it met the pinned Alpine builder.
      //
      // Deliberately NOT an assertion about include ORDER or a specific
      // header — only that a symbol the source uses has a header that defines
      // it. The real `docker build` remains the primary proof.
      const includes = [...holderSource.matchAll(/^\s*#\s*include\s+<([^>]+)>/gm)].map(
        (m) => m[1],
      );

      // Headers the C standard specifies as defining NULL.
      const NULL_HEADERS = [
        "stddef.h",
        "stdio.h",
        "stdlib.h",
        "string.h",
        "time.h",
        "locale.h",
        "wchar.h",
      ];

      const usesNull = /\bNULL\b/.test(holderSource.replace(/\/\*[\s\S]*?\*\//g, ""));
      if (usesNull) {
        assert.ok(
          includes.some((h) => NULL_HEADERS.includes(h)),
          `holder.c uses NULL but includes none of ${NULL_HEADERS.join(", ")} ` +
            `(includes: ${includes.join(", ") || "none"})`,
        );
      }
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
      // Presence only. The full /tmp/videofetch option contract — including the
      // uid/gid ownership grant this assertion used to certify away — is
      // asserted semantically in the two tests below.
      assert.match(exec, /--tmpfs\s+\/tmp\/videofetch:/);
      assert.match(exec, /--volume\s+\/var\/lib\/videofetch:\/var\/lib\/videofetch:rw\b/);
      assert.match(exec, /--volume\s+\/run\/videofetch-r2-broker:\/run\/videofetch-r2-broker:ro\b/);
      assert.match(exec, /--group-add\s+\$\{VIDEOFETCH_BROKER_GID\}/);
      assert.match(exec, /--cap-drop=ALL\b/);
      assert.match(exec, /--security-opt\s+no-new-privileges\b/);
    });

    // ── WORKER-TEMP-TMPFS-OWNERSHIP-001 ──────────────────────────────────
    //
    // The first production direct-media job failed PROCESSING_FAILED ~13ms in,
    // on `mkdir /tmp/videofetch/jobs` -> EACCES.
    //
    // The cause was mount semantics, not application code: a tmpfs is a fresh
    // filesystem mounted OVER /tmp/videofetch, so it SHADOWS the directory
    // Dockerfile.worker creates and chowns to node:node, and the kernel had
    // given that new mount root:root while the Worker runs as uid 1000. Image
    // ownership can never satisfy a path something else is mounted over, so
    // the MOUNT must carry the runtime identity.
    //
    // The old form of this suite asserted one exact option string and so
    // actively protected the broken declaration. These assert over the option
    // SET instead.
    it("mounts the media temp tmpfs writable by the Worker's own uid/gid", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      const options = tmpfsOptions(exec, "/tmp/videofetch");

      // uid/gid are the fix; rw/noexec/nosuid/size are what the fix must not
      // cost. 1000:1000 is the `node` user of the node:22-bookworm-slim base
      // that Dockerfile.worker switches to, written numerically because a
      // kernel mount option takes ids, not names.
      for (const required of ["rw", "noexec", "nosuid", "size=2g", "uid=1000", "gid=1000"]) {
        assert.ok(
          options.includes(required),
          `the /tmp/videofetch tmpfs must be mounted ${required} (got ${options.join(",")})`,
        );
      }
    });

    it("buys that writability with no loss of temp-filesystem hardening", () => {
      const exec = values(workerUnit, "ExecStart").join("\n");
      const options = tmpfsOptions(exec, "/tmp/videofetch");

      // Exact-token comparison, which is precisely what splitting on ',' buys:
      // `noexec` must never be relaxed to `exec`, and a substring check could
      // not tell those two apart.
      for (const forbidden of ["exec", "suid", "ro"]) {
        assert.equal(
          options.includes(forbidden),
          false,
          `the /tmp/videofetch tmpfs must never be mounted ${forbidden}`,
        );
      }

      // Writable by the WORKER is the fix. Writable by anyone is not: the
      // correction is an ownership grant, never a permission broadening.
      for (const option of options) {
        const mode = /^mode=([0-7]+)$/.exec(option)?.[1];
        if (mode === undefined) continue;
        assert.equal(
          Number.parseInt(mode.slice(-1), 8) & 0o2,
          0,
          `the /tmp/videofetch tmpfs must not be world-writable (${option})`,
        );
      }

      // And it must stay an ephemeral tmpfs. Swapping it for a host bind mount
      // would also "fix" the EACCES, by putting media working files on the VM
      // disk, outside the size bound and outside the container's lifetime.
      assert.doesNotMatch(exec, /--volume\s+\S*:\/tmp\/videofetch\b/);
      assert.doesNotMatch(exec, /--mount\s+\S*\/tmp\/videofetch\b/);
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
  describe("DNS firewall exception is unchanged by the resolver work", () => {
    it("still renders exactly one host on port 53, both transports, no range", () => {
      // The exception is RENDERED by the installer from the validated resolver
      // list; the template only carries the marker. Making the resolver durable
      // must not have widened either half.
      assert.match(nftTemplate, /^@@VIDEOFETCH_DESIGNATED_DNS@@$/m, "the template still substitutes, never hard-codes");
      const executable = executableLines(installScript);
      assert.match(executable, /daddr %s udp dport 53 counter accept comment "designated-dns-udp"/);
      assert.match(executable, /daddr %s tcp dport 53 counter accept comment "designated-dns-tcp"/);
      // Rendered from vf_dns_resolvers, which rejects anything that is not an
      // exact address, so no prefix can reach the ruleset.
      assert.match(executable, /vf_dns_resolvers/);
      assert.doesNotMatch(executable, /dport\s+\{[^}]*53/, "53 must never be folded into a port set");
    });

    it("adds no broad private-range allowance anywhere in the policy", () => {
      const executable = executableLines(nftTemplate);
      for (const broad of [/10\.0\.0\.0\/8[^\n]*accept/, /172\.16\.0\.0\/12[^\n]*accept/, /192\.168\.0\.0\/16[^\n]*accept/]) {
        assert.doesNotMatch(executable, broad, "no broad private range may be accepted");
      }
      const acceptedPorts = [...executable.matchAll(/dport\s+\{?\s*([0-9,\s]+)\}?/g)]
        .flatMap((m) => m[1].split(",").map((p) => p.trim()))
        .filter(Boolean);
      for (const port of acceptedPorts) {
        assert.ok(["80", "443"].includes(port), `unexpected accepted port ${port} in the template`);
      }
    });
  });

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
  // ────────────────────────────────────────────────────────────────────────
  describe("designated DNS resolver readiness (PRODUCTION-DNS-RESOLVER-001)", () => {
    let dnsUnit: string[];
    let dnsUnitSource: string;
    let dropIn: string;
    let dnsCheck: string;

    before(async () => {
      dnsUnitSource = await readFile(DNS_UNIT, "utf8");
      dnsUnit = parseUnit(dnsUnitSource);
      dropIn = await readFile(RESOLVED_DROPIN, "utf8");
      dnsCheck = await readFile(DNS_CHECK_SCRIPT, "utf8");
    });

    it("declares exactly one extra stub listener, and commits no address", () => {
      // Same convention as media-egress.env.example and the nftables template:
      // no deployment address is committed, because a committed address is one
      // that can silently disagree with the host it is installed on.
      const listeners = dropIn
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .filter((l) => /^\s*DNSStubListenerExtra\s*=/.test(l))
        .map((l) => l.slice(l.indexOf("=") + 1).trim());

      assert.equal(listeners.length, 1, "exactly one extra stub listener is declared");
      assert.equal(listeners[0], "", "the example must ship with no value filled in");
    });

    it("commits no wildcard listener, which would expose a resolver to the LAN", () => {
      const executable = dropIn.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      for (const wildcard of [/DNSStubListenerExtra\s*=\s*0\.0\.0\.0/, /DNSStubListenerExtra\s*=\s*::\s*$/, /DNSStubListenerExtra\s*=\s*\*/]) {
        assert.doesNotMatch(executable, wildcard, "the resolver must never bind a wildcard address");
      }
      assert.doesNotMatch(executable, /DNSStubListenerExtra\s*=\s*\S+\//, "a prefix is not an address");
      // DNSStubListener= (the loopback stub) must not be disturbed: turning it
      // off would break the VM's own resolution.
      assert.doesNotMatch(executable, /^\s*DNSStubListener\s*=/m, "the loopback stub must be left alone");
    });

    it("derives the probed address from config, never from the drop-in", () => {
      // Agreement between the two files is proved at RUNTIME rather than
      // asserted textually: the probe reads media-egress.env, so a drop-in
      // binding anything else fails readiness instead of passing quietly.
      const executable = executableLines(dnsCheck);
      assert.match(executable, /vf_config_load/, "config is the source of truth");
      assert.match(executable, /vf_dns_resolvers/, "addresses come from the shared parser");
      assert.doesNotMatch(executable, /resolved\.conf|DNSStubListenerExtra/, "the probe must not read the drop-in");
    });

    it("orders the resolver in FRONT of the namespace holder and the Worker", () => {
      // The defect this closes: a fresh boot reported six active units, a
      // healthy Worker and a passing verifier with no resolver in existence.
      assert.ok(
        tokens(netnsUnit, "After").includes("videofetch-media-dns.service"),
        "the holder must be ordered after resolver readiness",
      );
      assert.ok(
        tokens(netnsUnit, "Requires").includes("videofetch-media-dns.service"),
        "and must require it, so a boot cannot silently omit it",
      );
      for (const directive of ["After", "Requires", "BindsTo"]) {
        assert.ok(
          tokens(workerUnit, directive).includes("videofetch-media-dns.service"),
          `the Worker must declare ${directive}= on resolver readiness`,
        );
      }
    });

    it("does not weaken any existing security dependency", () => {
      for (const unit of ["videofetch-media-netns.service", "videofetch-egress-policy.service", "videofetch-egress-watchdog.service"]) {
        for (const directive of ["Requires", "After", "BindsTo"]) {
          assert.ok(
            tokens(workerUnit, directive).includes(unit),
            `${directive}=${unit} must survive the DNS change`,
          );
        }
      }
      // The holder must NOT bind to DNS: a transient resolver fault must not
      // tear down the namespace and force the policy to be reinstalled.
      assert.equal(
        tokens(netnsUnit, "BindsTo").includes("videofetch-media-dns.service"),
        false,
        "a DNS blip must not destroy the enforced namespace",
      );
    });

    it("runs the readiness probe as the unit's own work, with no capabilities", () => {
      assert.ok(
        values(dnsUnit, "ExecStart").some((v) => v.includes("vf-media-dns-check")),
        "the unit must run the readiness probe",
      );
      assert.ok(values(dnsUnit, "Type").includes("notify"), "readiness must be announced, not assumed");
      assert.ok(values(dnsUnit, "Restart").includes("no"), "fail closed like the egress watchdog");
      assert.deepEqual(values(dnsUnit, "CapabilityBoundingSet"), [""], "emitting a DNS query needs no capability");
      assert.ok(values(dnsUnit, "NoNewPrivileges").includes("yes"));
    });

    it("keeps FUNCTIONAL readiness separate from SECURITY verification", () => {
      // A DNS outage must not be reportable as a boundary breach, and a breach
      // must not be maskable by DNS being fine.
      assert.doesNotMatch(
        executableLines(dnsCheck),
        /vf-egress-policy-verify/,
        "the readiness probe must not invoke the security verifier",
      );
      assert.doesNotMatch(
        executableLines(verifySource),
        /vf-media-dns-check|dns.*readiness/i,
        "the security verifier must not depend on DNS working",
      );
      assert.doesNotMatch(
        executableLines(watchdogScript),
        /vf-media-dns-check/,
        "the egress watchdog must not depend on DNS working",
      );
    });

    it("probes only the configured resolver and never falls back to a public one", () => {
      const executable = executableLines(dnsCheck);
      assert.match(executable, /vf_dns_resolvers/, "addresses come from the shared config parser");
      for (const public_ of [/\b8\.8\.8\.8\b/, /\b1\.1\.1\.1\b/, /\b9\.9\.9\.9\b/, /\b208\.67\./]) {
        assert.doesNotMatch(executable, public_, "no public resolver may be baked in as a fallback");
      }
      assert.match(executable, /VF_DNS_PROBE_PORT:-53/, "port 53 is the only port the policy admits");
    });

    it("checks BOTH transports, because the policy admits both", () => {
      const executable = executableLines(dnsCheck);
      assert.match(executable, /for proto in udp tcp/, "UDP and TCP are both admitted and both must answer");
    });
  });

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
      assert.match(multicastScript, /trap cleanup EXIT\b/, "an EXIT trap must unwind every path");
      assert.match(multicastScript, /trap on_signal INT TERM/, "signals need their own handler");
      // Running cleanup() straight from the signal trap would misread $? as the
      // status of the interrupted command — usually 0 — and report success.
      assert.match(multicastScript, /INTERRUPTED=1/);
      // The trap must be installed BEFORE the first route is added. Compared on
      // EXECUTABLE lines only: the header comment draws the original race,
      // `ip route add` included, and prose must not decide this.
      const executable = executableLines(multicastScript);
      const trapIndex = executable.indexOf("trap cleanup EXIT");
      const addIndex = executable.indexOf("route add");
      assert.ok(trapIndex > 0 && addIndex > trapIndex, "the trap must precede any route mutation");
      assert.match(executable, /route del/, "cleanup must remove what it added");
    });

    it("adds narrow test routes inside the denied ranges, and never weakens policy", () => {
      assert.match(multicastScript, /VF_MULTICAST_V4_TEST:-224\.0\.2\.1\/32/, "a narrow IPv4 test destination");
      assert.match(multicastScript, /VF_MULTICAST_V6_TEST:-ff0e::1\/128/, "a narrow IPv6 test destination");
      assert.doesNotMatch(multicastScript, /nft\s+-f\b/, "it must never load a ruleset");
      assert.doesNotMatch(
        executableLines(multicastScript),
        /\bnft\b[^\n]*\b(add|delete|flush|insert|replace)\b/,
        "it must never mutate nftables",
      );
    });

    it("NEVER re-baselines a fingerprint (CORRECTION 01)", () => {
      // The original implementation re-baselined the ROUTE fingerprint while
      // its test routes were installed, so the stored baseline briefly
      // described a namespace with acceptance routes in it. The corrected
      // lifecycle quiesces instead, and the baseline keeps describing the clean
      // namespace throughout — which is what makes the final verification a
      // real check rather than a comparison against something this script
      // wrote moments earlier.
      const executable = executableLines(multicastScript);
      assert.doesNotMatch(executable, /--routes-baseline-only/, "no route re-baseline");
      assert.doesNotMatch(executable, /VF_EGRESS_INSTALL|vf-egress-policy-install/, "the helper must not invoke the installer");
      assert.doesNotMatch(executable, /expected\.sha256/, "the helper must not write any fingerprint");

      // And the entry point it used is gone from the installer entirely.
      assert.doesNotMatch(
        executableLines(installScript),
        /--routes-baseline-only/,
        "the narrow re-baseline mode must be removed, not merely unused",
      );
    });

    it("quiesces the production boundary instead of racing it (CORRECTION 01)", () => {
      const executable = executableLines(multicastScript);
      assert.match(executable, /stop"?\s+"\$WORKER_UNIT"/, "the Worker is stopped for the window");
      assert.match(executable, /stop"?\s+"\$WATCHDOG_UNIT"/, "the watchdog is stopped for the window");
      // And it asserts they really stopped rather than assuming.
      assert.match(executable, /refusing to mutate routes beneath a running Worker/);
      assert.match(executable, /refusing to mutate routes beneath a running watchdog/);
    });

    it("introduces no bypass into the production verifier or watchdog", () => {
      // The alternative fix — teaching the boundary to tolerate an "expected"
      // route delta — would put an exemption inside the production path, live
      // every second, for the sake of a measurement taken once.
      const production = executableLines(verifySource) + "\n" + executableLines(watchdogScript);
      for (const bypass of [
        /VF_ACCEPT_ROUTE_CHANGES/,
        /ACCEPTANCE_MODE/i,
        /MAINTENANCE/i,
        /\bbypass\b/i,
        /\bskip_route/i,
        /allow_route_delta/i,
      ]) {
        assert.doesNotMatch(production, bypass, `no ${bypass} escape hatch may exist in the boundary`);
      }
    });

    it("refuses to run outside the enforced media namespace", () => {
      assert.match(multicastScript, /list table inet videofetch_egress/);
    });

    // ── CORRECTION 02 ────────────────────────────────────────────────────
    //
    // Phase 9 ran the TCP version against the live boundary and the deny
    // counters stayed flat, because Linux rejects TCP to a multicast
    // destination in the socket layer before netfilter sees a packet. A probe
    // that cannot reach the rule cannot attribute anything to it.
    it("probes multicast with UDP, never TCP", () => {
      const executable = executableLines(multicastScript);
      assert.match(executable, /require\("node:dgram"\)/, "the probe must use UDP datagrams");
      assert.match(executable, /createSocket\(/, "a dgram socket is how the datagram is emitted");
      assert.doesNotMatch(
        executable,
        /require\("node:net"\)|new net\.Socket|\.connect\(\{/,
        "no TCP socket may remain: TCP to a multicast address never reaches the output hook",
      );
    });

    it("emits one bounded datagram for each family", () => {
      const executable = executableLines(multicastScript);
      // udp4/udp6 chosen from the destination, so both families are exercised
      // by the same probe rather than only IPv4 working.
      assert.match(executable, /udp6.*udp4|udp4.*udp6/s, "both IPv6 and IPv4 sockets must be reachable");
      assert.match(executable, /\.send\(/, "exactly one send() is the probe");
      assert.match(executable, /setTimeout\(/, "the probe must be bounded, never able to wedge the run");
      assert.match(executable, /deny-v4/, "IPv4 attribution rule");
      assert.match(executable, /deny-v6/, "IPv6 attribution rule");
    });

    it("still treats a flat counter as failure after the protocol change", () => {
      const executable = executableLines(multicastScript);
      // The dangerous "fix" would have been to accept the flat TCP result.
      assert.match(
        executable,
        /if \[ "\$\(\(after - before\)\)" -le 0 \]; then/,
        "no counter movement must still be a failure",
      );
      assert.match(executable, /NOT yet attributable/, "and must say so");
      assert.doesNotMatch(
        executable,
        /ENETUNREACH\)?\s*\)?\s*&&\s*(return 0|PROBE_RC=0)|treat.*flat.*as.*(pass|success)/i,
        "a flat counter may never be converted into success",
      );
    });

    it("keeps the disposable probe container unprivileged after the change", () => {
      const executable = executableLines(multicastScript);
      assert.match(executable, /--cap-drop=ALL/);
      assert.match(executable, /--security-opt no-new-privileges/);
      assert.match(executable, /--read-only/);
      assert.match(executable, /--user 65534:65534/);
      assert.match(executable, /--network "container:\$VF_NETNS_CONTAINER"/);
      for (const forbidden of [/--privileged/, /--cap-add/, /NET_ADMIN/, /SYS_ADMIN/, /--network host/, /docker\.sock/]) {
        assert.doesNotMatch(executable, forbidden, `the probe container must never use ${forbidden}`);
      }
    });

    it("leaves the quiesce/restore state machine and fingerprint handling untouched", () => {
      const executable = executableLines(multicastScript);
      assert.match(executable, /STATE=quiesced/);
      assert.match(executable, /STATE=mutated/);
      assert.match(executable, /route table did NOT return to its original state/);
      assert.doesNotMatch(executable, /expected\.sha256/, "still never writes a fingerprint");
      assert.match(executable, /trap cleanup EXIT\b/);
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
      // `v4route.fail` makes ONLY `ip -4 route show` exit nonzero, so a test
      // can tell "the route table could not be read" apart from "the route
      // table is empty" without touching any other subcommand.
      ip: `#!/bin/bash\nif [ "$1 $2 $3" = "-4 route show" ] && [ -e "$VT/v4route.fail" ]; then exit 9; fi\ncase "$1 $2 $3" in\n  "-4 route show") cat "$VT/v4route" ;;\n  "-6 route show") cat "$VT/v6route" ;;\n  "-4 rule show") cat "$VT/v4rule" ;;\n  "-6 rule show") cat "$VT/v6rule" ;;\n  "monitor route link") while :; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n`,
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

  // ── SIGPIPE false-fail (SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001-CORRECTION-01)
  //
  // Production symptom, seen during the Phase-8B final-stack cutover: the
  // verifier intermittently reported "namespace has NO IPv4 routes" against a
  // fully populated route table. The cause was shell-level, not policy-level:
  //
  //     ip -4 route show | grep -q .        # under `set -o pipefail`
  //
  // `grep -q` exits the moment it matches the first line and closes the pipe;
  // `ip` is still writing, takes SIGPIPE, exits 141; pipefail promotes that to
  // a failed pipeline and the verifier takes the `|| fail` branch.
  //
  // The direction is fail-CLOSED — it can only invent a FAILURE, never a
  // false PASS — but the verifier is the Worker's ExecStartPre and the
  // watchdog's 5s probe, so a false failure stops a healthy Worker.
  //
  // These tests pin the SEMANTICS, not the spelling: a reverted fix fails
  // them deterministically.
  describe("route existence check is not SIGPIPE-fragile", () => {
    /**
     * A producer that emits a first line and then far more than one pipe
     * buffer (64 KiB) of further output, so it is guaranteed to still be
     * writing when an early-exiting consumer closes the pipe. This is what
     * makes the reproduction deterministic rather than a 1-in-100 flake.
     */
    const PRODUCER = "printf 'default via 10.11.12.1 dev vfnet0\\n'; seq 1 200000";

    const runShell = (script: string) =>
      spawnSync("bash", ["-c", script], { env, encoding: "utf8" }).status;

    it("REPRODUCES the old form: a populated table reports as empty under pipefail", () => {
      // The bug itself, in isolation. If Bash ever stopped behaving this way
      // the correction would be unnecessary — so this asserts the hazard is
      // real on the machine running the suite.
      const status = runShell(`set -uo pipefail; { ${PRODUCER}; } | grep -q .`);
      assert.notEqual(
        status,
        0,
        "expected the old `producer | grep -q .` form to fail under pipefail despite non-empty output",
      );
    });

    it("the corrected capture form survives the same producer", () => {
      const status = runShell(
        `set -uo pipefail; OUT="$( { ${PRODUCER}; } )" || exit 1; [ -n "$OUT" ]`,
      );
      assert.equal(status, 0, "the capture form must not be affected by consumer close");
    });

    it("the shipped verifier does not pipe a namespace producer into an early-exiting consumer", async () => {
      // Spelling guard only — the behavioural tests below are the substance.
      const source = await readFile(VERIFY_SCRIPT, "utf8");
      assert.doesNotMatch(
        executableLines(source),
        /route\s+show[^\n]*\|\s*grep\s+-[a-zA-Z]*q/,
        "route existence must be established by capture, never by piping into `grep -q`",
      );
    });

    it("PASSES on a route table large enough to SIGPIPE the old form", async () => {
      // The real verifier, through the real fixture harness, against a route
      // table that the old form could not have survived. This is the
      // regression test proper: revert the fix and this goes red every run.
      const many = Array.from(
        { length: 5000 },
        (_, i) => `10.${(i >> 8) & 255}.${i & 255}.0/24 via 10.11.12.9 dev vfnet0 `,
      ).join("\n");
      await write("v4route", `${V4_ROUTES}${many}\n`);
      baseline();

      const { status, stderr } = verify();
      assert.equal(status, 0, stderr);

      await write("v4route", V4_ROUTES);
      baseline();
    });

    it("still FAILS when the IPv4 route table is genuinely empty", async () => {
      await write("v4route", "");
      baseline();

      const { status, stderr } = verify();
      assert.equal(status, 1);
      assert.match(stderr, /NO IPv4 routes/);

      await write("v4route", V4_ROUTES);
      baseline();
    });

    it("FAILS DISTINCTLY when the route command itself errors", async () => {
      // An unreadable route table is a different fault from an empty one, and
      // the old single `grep -q` could not tell them apart — both arrived as
      // "NO IPv4 routes". Neither may pass, and they must not be conflated.
      await write("v4route.fail", "");

      const { status, stderr } = verify();
      assert.equal(status, 1);
      assert.match(stderr, /cannot read the namespace IPv4 route table/);
      assert.doesNotMatch(stderr, /NO IPv4 routes/);

      await rm(join(sandbox, "v4route.fail"), { force: true });
    });
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

// ──────────────────────────────────────────────────────────────────────────
// CORRECTION 01 — the multicast acceptance lifecycle must not race the
// production watchdog.
//
// The original implementation mutated routes and only THEN re-baselined the
// route fingerprint, while the watchdog was still subscribed to route events:
//
//     helper                         watchdog
//     ip route add ...
//             ── route event ──────>
//                                    verify -> routes != fingerprint
//                                    BREACH: stop Worker, exit nonzero
//     re-baseline routes             (too late)
//
// Whether acceptance worked depended on scheduling. These tests pin the
// corrected ordering deterministically. The FIRST of them fails against the
// reviewed head 7fd5227, which never stopped anything.
// ──────────────────────────────────────────────────────────────────────────

const MC_CHAIN = `table inet videofetch_egress {
\tchain output {
\t\ttype filter hook output priority filter; policy drop;
\t\tip daddr @forbidden_v4 counter packets DENYV4 bytes 300 reject with icmp type admin-prohibited comment "deny-v4"
\t\tip6 daddr @forbidden_v6 counter packets DENYV6 bytes 80 reject with icmpv6 type admin-prohibited comment "deny-v6"
\t}
}
`;

const MC_V4_ROUTES = "default via 10.11.12.1 dev vfnet0 \n10.11.12.0/24 dev vfnet0 proto kernel scope link src 10.11.12.9 \n";
const MC_V6_ROUTES = "fe80::/64 dev vfnet0 proto kernel metric 256 pref medium\n";

describe("multicast acceptance lifecycle (SAFE-EGRESS-MULTICAST-ATTRIBUTION-001)", () => {
  let sandbox: string;
  let helper: string;
  let env: NodeJS.ProcessEnv;

  const p = (name: string) => join(sandbox, name);
  const write = (name: string, body: string) => writeFile(p(name), body);
  const read = async (name: string) => {
    try {
      return await readFile(p(name), "utf8");
    } catch {
      return "";
    }
  };

  /** Unit state as written by the systemctl stub, newline trimmed. */
  const readUnit = async (unit: string) => (await read(`unit-${unit}`)).trim();

  /** Restores the sandbox to a clean, verified, fully-running boundary. */
  async function reset(): Promise<void> {
    await write("v4route", MC_V4_ROUTES);
    await write("v6route", MC_V6_ROUTES);
    await write("ruleset", CANONICAL_RULESET);
    await write("chain", MC_CHAIN);
    await write("ctr-v4", "0");
    await write("ctr-v6", "0");
    await write("pid", "4242\n");
    await write("unit-videofetch-worker.service", "active");
    await write("unit-videofetch-egress-watchdog.service", "active");
    await rm(p("events.log"), { force: true });
    // Clear every stub flag, so a failing test cannot cascade into the next.
    for (const flag of ["inject", "probe-hang", "probe-flat", "probing"]) {
      await rm(p(flag), { force: true });
    }
    const result = spawnSync("bash", [VERIFY_SCRIPT], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `sandbox precondition failed: ${result.stderr}`);
  }

  function runHelper(args: string[] = ["--phase9-acceptance"]) {
    return spawnSync("bash", [helper, ...args], { env, encoding: "utf8", timeout: 60_000 });
  }

  /** The ordered log every stub appends to, as a list of event lines. */
  async function events(): Promise<string[]> {
    return (await read("events.log")).split("\n").filter(Boolean);
  }

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "vf-multicast-"));
    const bin = join(sandbox, "bin");
    await mkdir(bin);
    await mkdir(join(sandbox, "run"));

    const stubs: Record<string, string> = {
      // `inject` lets a test simulate something happening concurrently with the
      // first route mutation — a foreign route, or the policy being altered.
      ip: `#!/bin/bash
echo "ip $*" >> "$VT/events.log"
fam=$1; shift
case "$fam" in -4) rf="$VT/v4route" ;; -6) rf="$VT/v6route" ;; esac
case "$1 $2" in
  "route show") if [ "$3" = default ]; then grep '^default' "$rf"; else cat "$rf"; fi; exit 0 ;;
  "rule show")  if [ "$fam" = -4 ]; then printf '0:\\tfrom all lookup local\\n32766:\\tfrom all lookup main\\n32767:\\tfrom all lookup default\\n'; else printf '0:\\tfrom all lookup local\\n32766:\\tfrom all lookup main\\n'; fi; exit 0 ;;
  "route add")
      if [ -f "$VT/inject" ] && [ "$fam" = -4 ]; then bash "$VT/inject"; fi
      b=$(printf '%s' "$3" | sed -e 's|/32$||' -e 's|/128$||')
      echo "$b dev $5 scope link " >> "$rf"; exit 0 ;;
  "route del")
      b=$(printf '%s' "$3" | sed -e 's|/32$||' -e 's|/128$||')
      grep -v "^$b dev " "$rf" > "$rf.t" && mv "$rf.t" "$rf"; exit 0 ;;
esac
exit 1
`,
      systemctl: `#!/bin/bash
echo "systemctl $*" >> "$VT/events.log"
case "$1" in
  is-active) u="\${3:-$2}"; [ "$(cat "$VT/unit-$u" 2>/dev/null)" = active ] && exit 0 || exit 3 ;;
  stop)  echo inactive > "$VT/unit-$2"; exit 0 ;;
  start) echo active   > "$VT/unit-$2"; exit 0 ;;
esac
exit 0
`,
      docker: `#!/bin/bash
echo "docker $*" >> "$VT/events.log"
[ "$1" = inspect ] && { cat "$VT/pid"; exit 0; }
if [ "$1" = run ]; then
  touch "$VT/probing"
  [ -f "$VT/probe-hang" ] && sleep 3
  eval "host=\\\${$(($#-1))}"
  if [ -f "$VT/probe-flat" ]; then echo "DENIED(timeout)"; exit 0; fi
  if [ "\${host#*:}" != "$host" ]; then f=v6; else f=v4; fi
  n=$(cat "$VT/ctr-$f" 2>/dev/null || echo 0); echo $((n+1)) > "$VT/ctr-$f"
  echo "DENIED(EHOSTUNREACH)"; exit 0
fi
exit 1
`,
      nft: `#!/bin/bash
echo "nft $*" >> "$VT/events.log"
if [ "$1" = list ] && [ "$2" = ruleset ]; then cat "$VT/ruleset"; exit 0; fi
if [ "$1" = list ] && [ "$2" = table ]; then exit 0; fi
if [ "$1" = list ] && [ "$2" = chain ]; then
  sed -e "s/DENYV4/$(cat "$VT/ctr-v4")/" -e "s/DENYV6/$(cat "$VT/ctr-v6")/" "$VT/chain"; exit 0
fi
exit 1
`,
      nsenter: `#!/bin/bash\nshift 3\nexec "$@"\n`,
      sha256sum: `#!/bin/sh\nif command -v shasum >/dev/null 2>&1; then exec shasum -a 256; fi\nexec /usr/bin/sha256sum\n`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      await writeFile(join(bin, name), body);
      await chmod(join(bin, name), 0o755);
    }

    await write(
      "media-egress.env",
      'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 10.11.12.13"\n',
    );

    // The shipped helper refuses to run as non-root, and that gate is asserted
    // separately in the static suite. Here it is neutralized — and ONLY it — so
    // the lifecycle itself can be exercised without root.
    const shipped = await readFile(MULTICAST_SCRIPT, "utf8");
    assert.match(shipped, /\[ "\$\(id -u\)" -eq 0 \] \|\| vf_die/, "the shipped script must gate on root");
    helper = join(sandbox, "helper-noroot");
    await writeFile(helper, shipped.replace('[ "$(id -u)" -eq 0 ] || vf_die', "[ 1 -eq 0 ] && vf_die"));

    env = {
      ...process.env,
      VT: sandbox,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      VF_EGRESS_LIB: LIB_SCRIPT,
      VF_CONFIG_FILE: p("media-egress.env"),
      VF_RUNDIR: join(sandbox, "run"),
      VF_NFT: join(bin, "nft"),
      VF_IP: join(bin, "ip"),
      VF_DOCKER: join(bin, "docker"),
      VF_NSENTER: join(bin, "nsenter"),
      VF_SYSTEMCTL: join(bin, "systemctl"),
      VF_EGRESS_VERIFY: VERIFY_SCRIPT,
    };

    // Baseline the fingerprints the way the installer would.
    await write("v4route", MC_V4_ROUTES);
    await write("v6route", MC_V6_ROUTES);
    await write("ruleset", CANONICAL_RULESET);
    await write("pid", "4242\n");
    const baseline = spawnSync(
      "bash",
      [
        "-c",
        `. "$VF_EGRESS_LIB"
vf_canonical_ruleset 4242 | vf_sha256 > "$VF_RUNDIR/policy.expected.sha256"
vf_canonical_routes  4242 | vf_sha256 > "$VF_RUNDIR/routes.expected.sha256"`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(baseline.status, 0, baseline.stderr);
  });

  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("REGRESSION: stops the watchdog BEFORE mutating any route", async () => {
    // This is the correction. At the reviewed head 7fd5227 the helper issued no
    // `systemctl stop` at all, so this assertion fails there — the route event
    // reached a live watchdog and the outcome depended on scheduling.
    await reset();
    const result = runHelper();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const log = await events();
    const firstRouteMutation = log.findIndex((line) => /^ip .* route (add|del)\b/.test(line));
    const watchdogStop = log.findIndex((line) => line === "systemctl stop videofetch-egress-watchdog.service");
    const workerStop = log.findIndex((line) => line === "systemctl stop videofetch-worker.service");

    assert.ok(watchdogStop >= 0, "the watchdog must be stopped");
    assert.ok(workerStop >= 0, "the Worker must be stopped");
    assert.ok(firstRouteMutation >= 0, "a route must have been mutated");
    assert.ok(
      watchdogStop < firstRouteMutation,
      "the watchdog must be stopped BEFORE the first route mutation, not after it",
    );
    assert.ok(workerStop < firstRouteMutation, "the Worker must be stopped before the first route mutation");
    // The Worker goes down first, so it is never the thing BindsTo= drags down.
    assert.ok(workerStop < watchdogStop, "stop the Worker before the watchdog, explicitly");
  });

  it("REGRESSION: restarts the watchdog only AFTER the final verification", async () => {
    await reset();
    const result = runHelper();
    assert.equal(result.status, 0, result.stderr);

    const log = await events();
    const lastRouteDel = log.map((l) => /^ip .* route del\b/.test(l)).lastIndexOf(true);
    const watchdogStart = log.findIndex((l) => l === "systemctl start videofetch-egress-watchdog.service");
    const workerStart = log.findIndex((l) => l === "systemctl start videofetch-worker.service");

    assert.ok(lastRouteDel >= 0 && watchdogStart > lastRouteDel, "routes are removed before the watchdog returns");
    assert.ok(watchdogStart < workerStart, "the watchdog must be watching before the Worker runs again");

    assert.equal(await readUnit("videofetch-worker.service"), "active");
    assert.equal(await readUnit("videofetch-egress-watchdog.service"), "active");
  });

  it("never re-baselines either fingerprint across the whole lifecycle", async () => {
    await reset();
    const policyBefore = await read("run/policy.expected.sha256");
    const routesBefore = await read("run/routes.expected.sha256");

    assert.equal(runHelper().status, 0);

    assert.equal(await read("run/policy.expected.sha256"), policyBefore, "nftables baseline untouched");
    assert.equal(
      await read("run/routes.expected.sha256"),
      routesBefore,
      "the route baseline must keep describing the CLEAN namespace throughout",
    );
  });

  it("installs the intended multicast routes and attributes the denial to the rule", async () => {
    await reset();
    const result = runHelper();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /route delta is exactly the intended multicast test route\(s\)/);
    assert.match(result.stdout, /deny-v4 \+1/, "the IPv4 deny counter must move");
    assert.match(result.stdout, /deny-v6 \+1/, "the IPv6 deny counter must move");
    // A moving counter is the attribution. A flat one is still a failure, and
    // that is asserted separately.
    assert.match(result.stdout, /a moving counter attributes the denial to the rule itself/);
  });

  it("restores the route table exactly, and re-verifies before returning", async () => {
    await reset();
    const result = runHelper();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /route table restored exactly/);
    assert.match(result.stdout, /boundary verified after cleanup/);
    assert.equal(await read("v4route"), MC_V4_ROUTES, "IPv4 routes byte-identical");
    assert.equal(await read("v6route"), MC_V6_ROUTES, "IPv6 routes byte-identical");
  });

  it("REFUSES an unrelated route change that appears during the window", async () => {
    // Acceptance mode is bounded to the multicast delta. It is not a licence
    // for arbitrary route mutation.
    await reset();
    await write("inject", `printf '10.66.0.0/16 via 10.11.12.9 dev vfnet0 \\n' >> "$VT/v4route"\n`);

    const result = runHelper();
    assert.notEqual(result.status, 0, "an unexpected route must abort the run");
    assert.match(result.stderr, /UNEXPECTED route appeared during the measurement window/);

    // Its own routes are still cleaned up, and production stays DOWN because
    // the boundary no longer verifies.
    assert.equal((await read("v4route")).includes("224.0.2.1"), false, "acceptance routes removed anyway");
    assert.equal(await readUnit("videofetch-worker.service"), "inactive");
    assert.equal(await readUnit("videofetch-egress-watchdog.service"), "inactive");
    assert.match(result.stderr, /LEAVING/);
  });

  it("leaves production STOPPED if the boundary does not verify after cleanup", async () => {
    await reset();
    // Something alters the firewall during the window.
    await write("inject", `sed -i.b 's/{ 80, 443 }/{ 80, 443, 9999 }/' "$VT/ruleset"\n`);

    const result = runHelper();
    assert.notEqual(result.status, 0);
    assert.equal(await readUnit("videofetch-worker.service"), "inactive", "never restart into an unverified boundary");
    assert.equal(await readUnit("videofetch-egress-watchdog.service"), "inactive");
    await write("ruleset", CANONICAL_RULESET);
  });

  it("aborts if the nftables ruleset changes during the window", async () => {
    await reset();
    await write("inject", `sed -i.b 's/{ 80, 443 }/{ 80, 443, 4444 }/' "$VT/ruleset"\n`);
    const result = runHelper();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nftables ruleset changed during the measurement window|allow shape mismatch/);
    await write("ruleset", CANONICAL_RULESET);
  });

  it("cleans up on a SIGNAL, and says accurately why it stopped", async () => {
    await reset();
    await write("probe-hang", "1");
    await rm(p("probing"), { force: true });

    const child = spawn("bash", [helper, "--phase9-acceptance"], { env });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));

    // Wait until it is genuinely inside the measurement window.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await readFile(p("probing"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    child.kill("SIGINT");
    const code: number | null = await new Promise((resolve) => child.on("close", resolve));

    assert.notEqual(code, 0, "an interrupted acceptance run must not report success");
    assert.match(output, /route table restored exactly/, "the trap must fire on a signal");
    assert.equal((await read("v4route")).includes("224.0.2.1"), false, "no acceptance route left behind");
    assert.equal((await read("v6route")).includes("ff0e::1"), false);
    // The boundary is fine; production is left down deliberately, and the
    // message must not claim a verification failure that did not happen.
    assert.match(output, /boundary verified after cleanup/);
    assert.match(output, /run did not complete cleanly/);
    assert.doesNotMatch(output, /does NOT verify after cleanup/);

    await rm(p("probe-hang"), { force: true });
  });

  it("reports a flat counter as NOT attributable rather than as a pass", async () => {
    await reset();
    await write("probe-flat", "1");
    const result = runHelper();
    assert.notEqual(result.status, 0, "a flat counter is not a pass");
    assert.match(result.stderr, /did not increment - the denial is NOT yet attributable/);
    // Cleanup still happened.
    assert.equal(await read("v4route"), MC_V4_ROUTES);
    await rm(p("probe-flat"), { force: true });
  });

  it("restores normal verifier and watchdog behaviour afterwards", async () => {
    await reset();
    assert.equal(runHelper().status, 0);

    // The verifier passes on the restored boundary...
    assert.equal(spawnSync("bash", [VERIFY_SCRIPT], { env, encoding: "utf8" }).status, 0);

    // ...and an UNAUTHORIZED route change is once again a breach, with no
    // lingering acceptance allowance.
    await write("v4route", `${MC_V4_ROUTES}10.77.0.0/16 via 10.11.12.9 dev vfnet0 \n`);
    const after = spawnSync("bash", [VERIFY_SCRIPT], { env, encoding: "utf8" });
    assert.equal(after.status, 1);
    assert.match(after.stderr, /ROUTE TABLE mutated/);
    await write("v4route", MC_V4_ROUTES);
  });

  it("refuses to mutate anything if the boundary does not verify up front", async () => {
    await reset();
    await write("v4route", `${MC_V4_ROUTES}10.88.0.0/16 via 10.11.12.9 dev vfnet0 \n`);
    await rm(p("events.log"), { force: true });

    const result = runHelper();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not currently verify/);

    // Nothing was stopped and nothing was mutated.
    const log = await events();
    assert.equal(log.some((l) => /^systemctl stop/.test(l)), false, "must not stop units before deciding to run");
    assert.equal(log.some((l) => /route (add|del)/.test(l)), false, "must not touch routes");
    assert.equal(await readUnit("videofetch-worker.service"), "active", "production untouched");
    await write("v4route", MC_V4_ROUTES);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// BEHAVIOURAL: run the readiness probe against a real resolver, and against
// its absence. (PRODUCTION-DNS-RESOLVER-001)
//
// Static assertions cannot tell a probe that reports readiness correctly from
// one that reports it unconditionally — which is precisely the failure mode
// this whole gate exists to catch, since the stack already once reported six
// healthy units with no resolver in existence.
// ──────────────────────────────────────────────────────────────────────────
describe("designated DNS readiness behaviour (PRODUCTION-DNS-RESOLVER-001)", () => {
  let sandbox: string;
  let configFile: string;

  /**
   * Minimal DNS responder: echoes the transaction id, sets the response bit and
   * answers NXDOMAIN. Deliberately the *least* a real resolver would do, so the
   * probe cannot be passing because of something richer.
   */
  function reply(query: Buffer): Buffer {
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 12);
    header.writeUInt16BE(0x8183, 2); // QR=1, RD=1, RA=1, rcode=NXDOMAIN
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    return Buffer.concat([header, query.subarray(12)]);
  }

  /**
   * Starts the requested transports on `port`; returns a stop function.
   *
   * Cleans up partially-opened transports if the second one fails to bind.
   * Leaking a bound socket here would keep the test runner's event loop alive
   * forever after an unrelated failure.
   */
  async function serve(port: number, opts: { udp: boolean; tcp: boolean }): Promise<() => Promise<void>> {
    let udp: dgram.Socket | null = null;
    let tcp: net.Server | null = null;

    const stop = async () => {
      if (udp) await new Promise<void>((resolve) => udp!.close(() => resolve()));
      if (tcp) await new Promise<void>((resolve) => tcp!.close(() => resolve()));
      udp = null;
      tcp = null;
    };

    try {
      if (opts.udp) {
        const socket = dgram.createSocket("udp4");
        socket.on("message", (msg, rinfo) => socket.send(reply(msg), rinfo.port, rinfo.address));
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(port, "127.0.0.1", () => {
            socket.removeAllListeners("error");
            socket.on("error", () => {});
            resolve();
          });
        });
        udp = socket;
      }

      if (opts.tcp) {
        const server = net.createServer((socket) => {
          const chunks: Buffer[] = [];
          socket.on("data", (d) => {
            chunks.push(d);
            const all = Buffer.concat(chunks);
            if (all.length < 2) return;
            const want = all.readUInt16BE(0);
            if (all.length < 2 + want) return;
            const body = reply(all.subarray(2, 2 + want));
            const framed = Buffer.alloc(2 + body.length);
            framed.writeUInt16BE(body.length, 0);
            body.copy(framed, 2);
            socket.end(framed);
          });
          socket.on("error", () => socket.destroy());
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.removeAllListeners("error");
            server.on("error", () => {});
            resolve();
          });
        });
        tcp = server;
      }
    } catch (error) {
      await stop();
      throw error;
    }

    return stop;
  }

  /**
   * Binds the requested transports on a port that is free for BOTH protocols.
   *
   * A free UDP port does not imply a free TCP port — they are separate spaces —
   * so the port is chosen by actually binding what the test needs, retrying on
   * a collision with anything else running on the machine.
   */
  async function serveOnFreePort(opts: { udp: boolean; tcp: boolean }): Promise<{ port: number; stop: () => Promise<void> }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await freePort();
      try {
        // Always claim both protocols while choosing, so a later test that
        // needs the other transport on this number cannot collide either.
        const stop = await serve(port, opts);
        return { port, stop };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("could not find a port free on both protocols");
  }

  /** A candidate ephemeral port, free for TCP at the moment it is chosen. */
  async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  /**
   * ASYNC on purpose. The DNS responder above lives in this very process, so a
   * spawnSync() here would block the event loop for the whole run and the
   * responder could never answer — every probe would time out and the
   * "not ready" cases would pass for entirely the wrong reason.
   */
  function run(
    port: number,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("bash", [DNS_CHECK_SCRIPT], {
        env: {
          ...process.env,
          VF_CONFIG_FILE: configFile,
          VF_EGRESS_LIB: LIB_SCRIPT,
          VF_DNS_PROBE_PORT: String(port),
          VF_DNS_PROBE_TIMEOUT: "2",
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "vf-dns-"));
    configFile = join(sandbox, "media-egress.env");
    await writeFile(
      configFile,
      'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 127.0.0.1"\n',
    );
  });

  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("reports NOT ready when nothing is listening", async () => {
    const result = await run(await freePort());
    assert.notEqual(result.status, 0, "an absent resolver must fail the gate");
    assert.match(result.stderr, /NO ANSWER/, "and must say the resolver did not answer");
    // The wording must not let a reader mistake this for a boundary breach.
    assert.match(result.stderr, /FUNCTIONAL fault, not a boundary breach/);
  });

  it("reports ready when a resolver answers on BOTH transports", async () => {
    const { port, stop } = await serveOnFreePort({ udp: true, tcp: true });
    try {
      const result = await run(port);
      assert.equal(result.status, 0, `expected readiness, got: ${result.stderr}`);
      assert.match(result.stdout, /OK \(every designated resolver answers\)/);
    } finally {
      await stop();
    }
  });

  it("reports NOT ready when only UDP answers", async () => {
    const { port, stop } = await serveOnFreePort({ udp: true, tcp: false });
    try {
      const result = await run(port);
      assert.notEqual(result.status, 0, "the policy admits TCP 53 too; half a resolver is not ready");
      assert.match(result.stderr, /tcp\/\d+ -> NO ANSWER/);
    } finally {
      await stop();
    }
  });

  it("reports NOT ready when only TCP answers", async () => {
    const { port, stop } = await serveOnFreePort({ udp: false, tcp: true });
    try {
      const result = await run(port);
      assert.notEqual(result.status, 0, "UDP is the primary transport and must answer");
      assert.match(result.stderr, /udp\/\d+ -> NO ANSWER/);
    } finally {
      await stop();
    }
  });

  it("refuses a configuration whose resolver is not an exact address", async () => {
    const bad = join(sandbox, "bad.env");
    await writeFile(bad, 'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 172.17.0.0/16"\n');
    const result = await run(await freePort(), { VF_CONFIG_FILE: bad });
    assert.notEqual(result.status, 0, "a prefix is not a resolver address");
    assert.match(result.stderr, /not an exact IP address|configuration is invalid/);
  });

  it("never reports ready by falling back to some other resolver", async () => {
    // A perfectly good resolver exists on 127.0.0.1 while the config names
    // 127.0.0.9. A probe that "helpfully" fell back would pass here, and would
    // mask exactly the production defect this gate exists to catch.
    const { port, stop } = await serveOnFreePort({ udp: true, tcp: true });
    const elsewhere = join(sandbox, "elsewhere.env");
    await writeFile(elsewhere, 'VIDEOFETCH_WORKER_PORT=8080\nVIDEOFETCH_MEDIA_DNS_FLAGS="--dns 127.0.0.9"\n');
    try {
      const result = await run(port, { VF_CONFIG_FILE: elsewhere });
      assert.notEqual(result.status, 0, "readiness is about the configured address and no other");
    } finally {
      await stop();
    }
  });
});
