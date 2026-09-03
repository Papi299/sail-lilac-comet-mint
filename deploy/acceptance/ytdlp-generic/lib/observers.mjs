// The observer layer — the impure edge of the harness.
//
// Everything in `stage-a.mjs`, `stage-b.mjs`, `lifecycle.mjs` and
// `process-tree.mjs` is a pure function over an observation bundle. This module
// and its siblings (`control-plane.mjs`, `process-sampler.mjs`, `cases.mjs`) are
// what actually GO AND LOOK, so that Phase 10D runs reviewed code rather than
// improvising one.
//
// Two structural properties, not two documented intentions:
//
//   1. `runReadOnly` accepts ONLY commands matching the allowlist below. A
//      repair (§50) or a credential rotation (§51) is not "discouraged" — it is
//      unrepresentable, because `systemctl restart`, `nft`, `ip route add`,
//      `docker run`, `docker tag` and `sh -c` match no entry and the function
//      throws before a process is spawned.
//
//   2. Nothing here writes /etc/videofetch/worker.env or restarts the Worker to
//      change YTDLP_ENABLED (§10). The harness measures the deployment state it
//      is given; changing that state is the Phase-10D operator's own step.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactText } from "./redact.mjs";
import { fingerprintChain } from "./egress-policy.mjs";

const execFileAsync = promisify(execFile);

/** The durable state file the Worker owns on the VM. Read-only, and never copied. */
export const WORKER_STATE_DB = "/var/lib/videofetch/videofetch.db";

/**
 * The ONLY durable columns the harness may project.
 *
 * `url` is deliberately absent and must stay absent: the durable row holds the
 * operator-supplied acceptance URL, which during the sentinel case carries the
 * sentinel itself. Selecting it would defeat both the URL redaction contract and
 * the sentinel test, in the one place where the data is at its most raw.
 */
export const DURABLE_SAFE_COLUMNS = Object.freeze(["job_id", "status", "format_id", "extractor"]);

/**
 * The ONLY `ps` output format this harness may request.
 *
 * `=` suffixes suppress the headers, so the output is pure data. There is no
 * `args`, `cmd` or `command` column and there cannot be one: the allowlist
 * admits this exact string and nothing else.
 */
export const HOST_PS_FORMAT = "pid=,ppid=,pgid=,comm=";

/**
 * The nftables chain the Phase-9 policy installs, as one argv token.
 *
 * `nft list chain inet videofetch_egress output` — table family, table name and
 * chain are fixed here so the allowlist admits exactly this listing and nothing
 * else.
 */
export const EGRESS_TABLE = "videofetch_egress";
export const EGRESS_CHAIN = "output";

/** Builds the one admissible listing argv for a validated namespace PID. */
export function egressChainListArgv(netnsPid) {
  if (!Number.isInteger(netnsPid) || netnsPid <= 0) {
    throw new Error("refusing to enter a namespace by a malformed pid");
  }
  return ["-t", String(netnsPid), "-n", "nft", "-j", "list", "chain", "inet", EGRESS_TABLE, EGRESS_CHAIN];
}

/** A durable job id, as the Worker's own schema defines it. */
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The exact SQL this harness may ever run. Built here, never assembled from input. */
export function durableJobQuery(jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId))) throw new Error("refusing to query a malformed job id");
  return `SELECT ${DURABLE_SAFE_COLUMNS.join(", ")} FROM jobs WHERE job_id = '${jobId}';`;
}

/** The fixed shape a durable read must have, so `sqlite3` cannot become a SQL console. */
const DURABLE_QUERY_PATTERN = new RegExp(
  `^SELECT ${DURABLE_SAFE_COLUMNS.join(", ")} FROM jobs WHERE job_id = '[0-9a-f]{32}';$`,
);

/**
 * The complete set of shapes this harness may execute.
 *
 * Each entry is `[executable, argv predicate]`. A command is admissible only if
 * some entry's executable matches AND its predicate accepts the full argv.
 */
const READ_ONLY_COMMANDS = Object.freeze([
  // Read-only container and image introspection.
  ["docker", (a) => a[0] === "inspect"],
  ["docker", (a) => a[0] === "image" && a[1] === "inspect"],
  ["docker", (a) => a[0] === "logs"],
  // Process listing with an EXPLICIT safe column set — never a command line.
  ["docker", (a) => a[0] === "top"],
  // Version probes inside the running container. Read-only by argument shape:
  // the allowlist admits exactly the known version invocations and nothing
  // else, so `docker exec` cannot become a general remote shell.
  ["docker", (a) => a[0] === "exec" && isVersionProbe(a)],
  // Read-only unit state.
  ["systemctl", (a) => a[0] === "is-active" || a[0] === "show" || a[0] === "status"],
  ["journalctl", () => true],
  // The existing read-only safe-egress verifier. It never repairs.
  ["/usr/local/sbin/vf-egress-policy-verify", (a) => a.length === 0],
  // Read-only process/namespace metadata.
  //
  // ONE exact invocation (§7 of CORRECTION-03). `ps -ef` and `ps aux` both
  // print the full command line, whose last element on the acquisition process
  // is the operator-supplied media URL — and, during the sentinel case, the
  // sentinel. Selecting the four safe columns by name means the URL is never
  // read, rather than being read and then redacted.
  ["ps", (a) => a.length === 2 && a[0] === "-eo" && a[1] === HOST_PS_FORMAT],
  ["readlink", (a) => a.length === 1 && a[0].startsWith("/proc/")],
  // The Phase-9 deny-counter instrument, read-only.
  //
  // ONE exact shape: `nsenter -t <pid> -n nft -j list chain inet
  // videofetch_egress output`. No mutation verb, no arbitrary nft expression,
  // no shell pipeline. The JSON is parsed in reviewed code, exactly as
  // deploy/acceptance/safe-egress/counter.py does.
  [
    "nsenter",
    (a) =>
      a.length === 10 &&
      a[0] === "-t" &&
      /^\d+$/.test(a[1]) &&
      a[2] === "-n" &&
      a[3] === "nft" &&
      a[4] === "-j" &&
      a[5] === "list" &&
      a[6] === "chain" &&
      a[7] === "inet" &&
      a[8] === EGRESS_TABLE &&
      a[9] === EGRESS_CHAIN,
  ],
  // Durable state, read-only, projecting only the safe column list.
  [
    "sqlite3",
    (a) =>
      a.length === 3 &&
      a[0] === "-readonly" &&
      a[1] === WORKER_STATE_DB &&
      DURABLE_QUERY_PATTERN.test(a[2]),
  ],
]);

/** The only in-container commands the allowlist admits. */
function isVersionProbe(argv) {
  const joined = argv.slice(2).join(" "); // drop `exec <container>`
  return (
    joined === "/usr/bin/python3 --version" ||
    joined === "node --version" ||
    joined === "/usr/bin/python3 /usr/local/lib/videofetch/yt-dlp --version" ||
    joined === EJS_PROBE_ARGV.join(" ") ||
    isWorkDirProbe(argv)
  );
}

/** `python3 -c <fixed isdir expression>` and nothing else. */
function isWorkDirProbe(argv) {
  const tail = argv.slice(2);
  return (
    tail.length === 3 &&
    tail[0] === "/usr/bin/python3" &&
    tail[1] === "-c" &&
    WORKDIR_PROBE_PATTERN.test(tail[2])
  );
}

/**
 * The bundled-EJS version probe.
 *
 * Prints EXACTLY the version string and nothing else — no module path, no
 * environment, no traceback body. `sys.path` is extended to the pinned
 * zipimport artifact, which is where `yt_dlp_ejs` lives; a failure prints the
 * fixed token `UNAVAILABLE` rather than a Python error, so nothing about the
 * image's internals can arrive through this channel.
 */
export const EJS_PROBE_ARGV = Object.freeze([
  "/usr/bin/python3",
  "-c",
  "import sys;sys.path.insert(0,'/usr/local/lib/videofetch/yt-dlp')\n" +
    "try:\n from yt_dlp_ejs import __version__ as v\n print(v)\n" +
    "except Exception:\n print('UNAVAILABLE')",
]);

/**
 * The per-job working-directory probe.
 *
 * A FIXED shape with only a validated 32-hex job id interpolated, printing
 * exactly `True` or `False`. Cancellation and byte-limit acceptance must prove
 * the workDir is GONE, and without this the harness could not observe absence
 * at all — which would have meant either widening the allowlist to a general
 * container shell, or reporting an unprovable cleanup. Neither is acceptable,
 * so the capability is added at exactly the width the assertion needs.
 */
export function workDirProbeArgv(jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId))) throw new Error("refusing to probe a malformed job id");
  return Object.freeze([
    "/usr/bin/python3",
    "-c",
    `import os;print(os.path.isdir('/tmp/videofetch/jobs/${jobId}'))`,
  ]);
}

const WORKDIR_PROBE_PATTERN =
  /^import os;print\(os\.path\.isdir\('\/tmp\/videofetch\/jobs\/[0-9a-f]{32}'\)\)$/;

/**
 * The Worker's own default when `MAX_FILE_SIZE` is unset, mirroring
 * `MEDIA_DEFAULTS.maxFileSizeBytes` in `src/worker/runtime/config.server.ts`.
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/**
 * The EFFECTIVE deployed byte limit, by the Worker's own grammar (§13 of
 * CORRECTION-04).
 *
 * The acceptance assertion is about the limit the DEPLOYED Worker enforces, not
 * about the repository default — a deployment that sets `MAX_FILE_SIZE=1048576`
 * has a 1 MiB limit, and a fixture serving 600 MiB would then prove nothing the
 * default-based reasoning claimed. So the single non-secret variable is read
 * from the container's bound environment and parsed HERE with exactly the
 * runtime's rules:
 *
 *   `optional()`        — trimmed; empty becomes absent
 *   absent              — the 500 MiB default
 *   `boundedInt(1, …)`  — /^[0-9]{1,17}$/ and a safe integer >= 1
 *
 * An out-of-grammar value is NOT silently defaulted here even though
 * `readOptionalField` returns the fallback, because the runtime also pushes the
 * name onto `invalid` and `loadWorkerRuntimeConfig` then THROWS — the Worker
 * would not be running at all. A running Worker whose `MAX_FILE_SIZE` does not
 * parse is a contradiction we cannot resolve, so it is a measurement failure.
 */
export function parseMaxFileSize(raw) {
  if (raw === null || raw === undefined) {
    return { measured: true, bytes: DEFAULT_MAX_FILE_SIZE_BYTES, source: "default" };
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) {
    return { measured: true, bytes: DEFAULT_MAX_FILE_SIZE_BYTES, source: "default" };
  }
  if (!/^[0-9]{1,17}$/.test(trimmed)) {
    return {
      measured: false,
      reason:
        "the deployed MAX_FILE_SIZE is not a nonnegative decimal integer; a Worker with this " +
        "value could not have started, so the effective limit cannot be established",
    };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      measured: false,
      reason: "the deployed MAX_FILE_SIZE is outside the range the Worker accepts",
    };
  }
  return { measured: true, bytes: parsed, source: "deployment" };
}

export function isReadOnlyCommand(file, argv) {
  const args = Array.isArray(argv) ? argv : [];
  return READ_ONLY_COMMANDS.some(([exe, predicate]) => exe === file && predicate(args) === true);
}

/**
 * Runs one read-only command.
 *
 * Refuses anything outside the allowlist. The refusal is an exception rather
 * than a falsy result so it can never be mistaken for a measurement.
 */
export async function runReadOnly(file, argv, opts = {}) {
  if (!isReadOnlyCommand(file, argv)) {
    throw new Error(
      `refusing to execute a command outside the read-only allowlist: ${file} ${(argv ?? [])
        .slice(0, 2)
        .join(" ")}`,
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    // A non-zero exit is DATA (the egress verifier failing is a finding), not a
    // harness crash. Output is redacted before it can reach a report.
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: redactText(error.stdout ?? ""),
      stderr: redactText(error.stderr ?? ""),
      spawnError: typeof error.code === "string" ? error.code : null,
    };
  }
}

/** Wraps a producer so any failure becomes `{ measured: false, reason }` (§49). */
export async function observe(reason, producer) {
  try {
    const value = await producer();
    if (value === undefined) return { measured: false, reason: `${reason}: produced no value` };
    return { measured: true, value };
  } catch (error) {
    return { measured: false, reason: `${reason}: ${redactText(String(error?.message ?? error))}` };
  }
}

/** A never-measured observation, for surfaces this run deliberately did not reach. */
export function notMeasured(reason) {
  return Object.freeze({ measured: false, reason });
}

// ── System observers ───────────────────────────────────────────────────────

export function makeSystemObservers(deps = {}) {
  const run = deps.runReadOnly ?? runReadOnly;
  const container = deps.container ?? "videofetch-worker";
  const imageRepo = deps.imageRepo ?? "videofetch-worker";

  /** `docker inspect --format` on the container, returning a trimmed scalar. */
  async function inspectContainer(format) {
    const result = await run("docker", ["inspect", "--format", format, container]);
    return String(result.stdout ?? "").trim();
  }

  /** Resolves one image REFERENCE to its content id, or null when absent. */
  async function imageId(reference) {
    const result = await run("docker", ["image", "inspect", "--format", "{{.Id}}", reference]);
    if (result.exitCode !== 0) return null;
    const id = String(result.stdout ?? "").trim();
    return /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
  }

  const observers = {
    async serviceState(unit) {
      return observe(`systemctl is-active ${unit}`, async () => {
        const result = await run("systemctl", ["is-active", unit]);
        // `is-active` exits non-zero for an inactive unit; the STATE is the
        // measurement, so a non-zero exit is data rather than a failure.
        return { unit, activeState: String(result.stdout ?? "").trim() || "unknown" };
      });
    },

    async runningImageId() {
      return observe("docker inspect worker image id", async () => {
        const id = await inspectContainer("{{.Image}}");
        if (!id) throw new Error("the Worker container is not running");
        return id;
      });
    },

    /**
     * §6 of CORRECTION-01 — the concrete image-identity observer.
     *
     * Resolves `videofetch-worker:<authorized sha>` and compares it with the id
     * the running container actually reports. Inspection only: no build, no
     * tag, no pull.
     */
    async imageShaTag(expectedSha) {
      return observe(`docker image inspect ${imageRepo}:<sha>`, async () => {
        if (!/^[0-9a-f]{7,40}$/.test(String(expectedSha ?? ""))) {
          throw new Error("no authorized --expected-sha was supplied");
        }
        const taggedImageId = await imageId(`${imageRepo}:${expectedSha}`);
        if (!taggedImageId) {
          throw new Error(`no local image is tagged ${imageRepo}:${expectedSha}`);
        }
        const runningImageId = await inspectContainer("{{.Image}}");
        return { expectedSha, taggedImageId, runningImageId };
      });
    },

    /**
     * The unit still starts `videofetch-worker:latest`, so `latest` and the SHA
     * tag must name ONE image object; two ids mean the unit would start an
     * image nobody reviewed.
     */
    async imageLatestAlias(expectedSha) {
      return observe(`docker image inspect ${imageRepo}:latest`, async () => {
        if (!/^[0-9a-f]{7,40}$/.test(String(expectedSha ?? ""))) {
          throw new Error("no authorized --expected-sha was supplied");
        }
        const latestImageId = await imageId(`${imageRepo}:latest`);
        const taggedImageId = await imageId(`${imageRepo}:${expectedSha}`);
        if (!latestImageId) throw new Error(`no local image is tagged ${imageRepo}:latest`);
        return { latestImageId, taggedImageId };
      });
    },

    async networkMode() {
      return observe("docker inspect network mode", async () =>
        inspectContainer("{{.HostConfig.NetworkMode}}"),
      );
    },

    /**
     * The Worker's bound environment VARIABLE NAMES (§16/§17).
     *
     * `{{range .Config.Env}}` yields `NAME=value` pairs, so the value is split
     * off and discarded here, in the observer, before it can reach any other
     * layer. Nothing downstream ever holds a value to accidentally print.
     */
    async environmentNames() {
      return observe("docker inspect worker environment names", async () => {
        const raw = await inspectContainer("{{range .Config.Env}}{{println .}}{{end}}");
        return raw
          .split("\n")
          .map((line) => line.split("=")[0].trim())
          .filter((name) => name.length > 0);
      });
    },

    /**
     * `YTDLP_ENABLED` as the deployment actually set it.
     *
     * Read from the container's bound environment rather than by reading
     * worker.env, so the harness never opens the secret-bearing file at all.
     * An unset variable yields `null`, which Stage A treats as disabled.
     */
    async ytdlpEnabledRaw() {
      return observe("docker inspect YTDLP_ENABLED", async () => {
        const raw = await inspectContainer("{{range .Config.Env}}{{println .}}{{end}}");
        for (const line of raw.split("\n")) {
          const [name, ...rest] = line.split("=");
          if (name.trim() === "YTDLP_ENABLED") return rest.join("=").trim();
        }
        return null;
      });
    },

    /**
     * The EFFECTIVE `maxFileSizeBytes` the deployed Worker enforces (§13).
     *
     * Read from the container's bound environment exactly as `ytdlpEnabledRaw`
     * is, so no environment FILE is opened and no value other than this single
     * non-secret variable is ever extracted. `environmentNames` remains the
     * name-only observer; this one deliberately reads one named value, because
     * the byte-limit assertion is a numeric comparison and cannot be made
     * against a name.
     */
    async effectiveMaxFileSize() {
      return observe("docker inspect MAX_FILE_SIZE", async () => {
        const raw = await inspectContainer("{{range .Config.Env}}{{println .}}{{end}}");
        let value = null;
        for (const line of raw.split("\n")) {
          const [name, ...rest] = line.split("=");
          if (name.trim() === "MAX_FILE_SIZE") {
            value = rest.join("=").trim();
            break;
          }
        }
        const parsed = parseMaxFileSize(value);
        if (parsed.measured !== true) throw new Error(parsed.reason);
        return { bytes: parsed.bytes, source: parsed.source };
      });
    },

    async egressVerifier() {
      return observe("vf-egress-policy-verify", async () => {
        const result = await run("/usr/local/sbin/vf-egress-policy-verify", []);
        // Reported, never repaired (§50).
        return { exitCode: result.exitCode };
      });
    },

    async pythonVersion() {
      return observe("python3 --version", async () => {
        const result = await run("docker", ["exec", container, "/usr/bin/python3", "--version"]);
        return String(result.stdout || result.stderr || "").trim().replace(/^Python\s+/i, "");
      });
    },

    async nodeVersion() {
      return observe("node --version", async () => {
        const result = await run("docker", ["exec", container, "node", "--version"]);
        return String(result.stdout ?? "").trim();
      });
    },

    /** §7 of CORRECTION-01 — the concrete bundled-EJS observer. */
    async bundledEjsVersion() {
      return observe("bundled yt_dlp_ejs version", async () => {
        const result = await run("docker", ["exec", container, ...EJS_PROBE_ARGV]);
        const value = String(result.stdout ?? "").trim();
        // The probe prints a version or the fixed token. Anything else is a
        // measurement failure, never a reported value.
        if (!/^\d+\.\d+\.\d+$/.test(value)) {
          throw new Error(`the EJS probe did not report a version (${value === "UNAVAILABLE" ? "UNAVAILABLE" : "unexpected output"})`);
        }
        return value;
      });
    },

    /**
     * Durable job evidence, projecting ONLY the safe columns.
     *
     * The row also holds the submitted URL; it is never selected. See
     * `DURABLE_SAFE_COLUMNS`.
     */
    async durableJobRow(jobId) {
      return observe(`durable job ${jobId}`, async () => {
        const result = await run("sqlite3", ["-readonly", WORKER_STATE_DB, durableJobQuery(jobId)]);
        if (result.exitCode !== 0) throw new Error("durable state could not be read");
        const line = String(result.stdout ?? "").trim();
        if (!line) throw new Error("no durable row exists for this job");
        const parts = line.split("|");
        if (parts.length !== DURABLE_SAFE_COLUMNS.length) {
          throw new Error("durable row shape did not match the projected columns");
        }
        const [jobIdValue, status, formatId, extractor] = parts;
        return { jobId: jobIdValue, status, formatId, extractor };
      });
    },

    /**
     * Whether a per-job working directory still exists inside the container.
     *
     * An unreadable answer is a MEASUREMENT FAILURE, never "absent": reporting
     * absence we could not observe is exactly the SKIPPED->PASS edge §49 bans.
     */
    async workDirPresent(jobId) {
      return observe(`workDir for job ${jobId}`, async () => {
        const result = await run("docker", ["exec", container, ...workDirProbeArgv(jobId)]);
        const value = String(result.stdout ?? "").trim();
        if (value !== "True" && value !== "False") {
          throw new Error("the workDir probe did not return a boolean");
        }
        return value === "True";
      });
    },

    /**
     * The container's main PID, used to detect a Worker restart (§6 of
     * CORRECTION-02). A different PID means the container was recreated.
     */
    async containerPid() {
      return observe("docker inspect container pid", async () => {
        const raw = await inspectContainer("{{.State.Pid}}");
        const pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("the container is not running");
        return pid;
      });
    },

    /**
     * The media namespace holder's PID, which `nsenter -n` needs.
     *
     * The namespace is owned by `videofetch-media-netns`, and the Worker joins
     * it; entering by PID is how the Phase-9 tooling already reads counters.
     */
    async mediaNetnsPid() {
      return observe("media namespace holder pid", async () => {
        const result = await run("docker", [
          "inspect",
          "--format",
          "{{.State.Pid}}",
          "videofetch-media-netns",
        ]);
        const pid = Number(String(result.stdout ?? "").trim());
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("the media namespace holder is not running");
        return pid;
      });
    },

    /**
     * The live egress chain, as nftables JSON.
     *
     * Read-only, through the one allowlisted listing shape. This is the same
     * instrument `deploy/acceptance/safe-egress/counter.py` consumes.
     */
    async egressChainListing() {
      return observe("nftables egress chain listing", async () => {
        const netnsPid = await observers.mediaNetnsPid();
        if (netnsPid.measured !== true) throw new Error(netnsPid.reason);
        const result = await run("nsenter", egressChainListArgv(netnsPid.value));
        if (result.exitCode !== 0) throw new Error(`nft listing exited ${result.exitCode}`);
        return JSON.parse(String(result.stdout ?? ""));
      });
    },

    /**
     * The safe-egress policy state: the read-only verifier's verdict PLUS a
     * fingerprint of the actual rules (§16 of CORRECTION-03).
     *
     * The previous fingerprint was the policy unit's systemd InvocationID and
     * activation timestamp, which describe the unit's lifetime rather than the
     * ruleset — a rule changed by hand while the unit kept running would leave
     * both identical. This hashes the normalized chain JSON with the mutable
     * counters stripped, so the rules are what is compared.
     */
    async egressPolicyState() {
      return observe("safe-egress policy state", async () => {
        const verify = await run("/usr/local/sbin/vf-egress-policy-verify", []);
        const listing = await observers.egressChainListing();
        if (listing.measured !== true) throw new Error(listing.reason);
        const fingerprinted = fingerprintChain(listing.value);
        if (fingerprinted.measured !== true) throw new Error(fingerprinted.reason);
        return {
          capturedAt: new Date().toISOString(),
          verifierExit: verify.exitCode,
          fingerprint: createHash("sha256").update(fingerprinted.normalized, "utf8").digest("hex"),
          listing: listing.value,
        };
      });
    },

    /**
     * Host-level survivors of an EXACT process group (§7 of CORRECTION-03).
     *
     * After a cancellation or a Worker restart the old acquisition process may
     * be orphaned or re-parented, so it is no longer a descendant of the
     * current Worker. `descendantsOf(currentWorkerPid)` therefore cannot answer
     * "did the group I captured actually die?" — a leaked, re-parented yt-dlp
     * would look clean. This asks the host directly.
     *
     * Collects only pid/ppid/pgid/comm. No command line, ever.
     */
    async processGroupMembers(pgid) {
      return observe(`host process group ${pgid}`, async () => {
        if (!Number.isInteger(pgid) || pgid <= 0) {
          throw new Error("refusing to query a malformed process group id");
        }
        const result = await run("ps", ["-eo", HOST_PS_FORMAT]);
        if (result.exitCode !== 0) throw new Error(`ps exited ${result.exitCode}`);
        // §23: an uninterpretable row makes the WHOLE listing unmeasured. The
        // absence of survivors is the evidence, so a row we could not read is
        // indistinguishable from the survivor we are looking for.
        const parsed = parseHostProcessList(result.stdout);
        if (!parsed.ok) throw new Error(parsed.reason);
        return parsed.rows.filter((row) => row.pgid === pgid);
      });
    },

    /** Read-only log capture for the sentinel sweep. Logging config is never changed (§47). */
    async workerLogs(sinceIso) {
      return observe("docker logs", async () => {
        const args = ["logs", container];
        if (sinceIso) args.push("--since", sinceIso);
        const result = await run("docker", args);
        if (result.exitCode !== 0) throw new Error(`docker logs exited ${result.exitCode}`);
        return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      });
    },

    async workerJournal(sinceIso) {
      return observers.unitJournal("videofetch-worker", sinceIso);
    },

    /**
     * Any unit's journal, read-only.
     *
     * §19 of CORRECTION-02 requires the cloudflared-relevant surface to have a
     * real observer rather than being quietly omitted from the sentinel sweep.
     */
    async unitJournal(unit, sinceIso) {
      return observe(`journalctl ${unit}`, async () => {
        const args = ["-u", unit, "--no-pager"];
        if (sinceIso) args.push("--since", sinceIso);
        const result = await run("journalctl", args);
        if (result.exitCode !== 0) throw new Error(`journalctl exited ${result.exitCode}`);
        return String(result.stdout ?? "");
      });
    },
  };

  return observers;
}

/**
 * Parses `ps -eo pid=,ppid=,pgid=,comm=` into closed-schema rows, FAIL-CLOSED
 * (§22-§24 of CORRECTION-04).
 *
 * ── Why dropping a row is not a safe default here ──────────────────────────
 *
 * The termination proof this feeds is a NEGATIVE one: "no member of the
 * captured process group survives". Its evidence is the ABSENCE of matching
 * rows. So a row the parser cannot interpret is not noise to be skipped — it is
 * potentially the one surviving leaked acquisition process, and skipping it
 * turns a single real survivor into `[]` and therefore into a PASS.
 *
 * The previous implementation did exactly that: `continue` on a wrong field
 * count, on a non-numeric id, and on an unexpected `comm` shape. Every one of
 * those is now a MEASUREMENT FAILURE for the whole listing.
 *
 * The privacy contract is unchanged and is what makes fail-closed affordable:
 * the command is the single allowlisted `ps -eo pid=,ppid=,pgid=,comm=`, which
 * has no `args`/`cmd`/`command` column, so an unparseable row cannot be
 * admitted "just in case" — it is refused, and nothing from it reaches the
 * evidence path. BLOCKED is the correct verdict for a listing we could not
 * fully read; it is never traded for a cleaner-looking empty set.
 *
 * @returns `{ ok: true, rows }` or `{ ok: false, reason }`. The reason names the
 *   line NUMBER and the defect, never the line's content — a malformed line is
 *   exactly the case where the content might not be a `comm`.
 */
export function parseHostProcessList(stdout) {
  const rows = [];
  const lines = String(stdout ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    // A blank line carries no process and hides nothing.
    if (trimmed.length === 0) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length !== 4) {
      return {
        ok: false,
        reason:
          `line ${index + 1} of the host process listing has ${parts.length} fields, not the 4 the ` +
          "requested format produces; the listing cannot be interpreted",
      };
    }
    const [pid, ppid, pgid, comm] = parts;
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid) || !/^\d+$/.test(pgid)) {
      return {
        ok: false,
        reason: `line ${index + 1} of the host process listing has a non-numeric id field`,
      };
    }
    if (!/^[\w.:+-]{1,64}$/.test(comm)) {
      return {
        ok: false,
        reason:
          `line ${index + 1} of the host process listing has a comm field that is not a plain ` +
          "executable basename; refusing to admit it rather than risk command-line material",
      };
    }
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm: comm.toLowerCase() });
  }
  return { ok: true, rows };
}
