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
  // Read-only container and image introspection, restricted to the EXACT
  // templates this harness uses (§4 of CORRECTION-05).
  //
  // `docker inspect` is read-only, but `--format '{{range .Config.Env}}...'`
  // returns the complete `NAME=value` environment — every Worker secret
  // included. Leaving the verb open and merely not using that template would
  // make the secret one template string away; naming the four templates makes
  // retrieving the environment through `docker inspect` unrepresentable.
  ["docker", (a) => a[0] === "inspect" && isAllowedInspect(a)],
  ["docker", (a) => a[0] === "image" && a[1] === "inspect" && isAllowedImageInspect(a)],
  ["docker", (a) => a[0] === "logs"],
  // Process listing with an EXPLICIT safe column set — never a command line.
  //
  // §6 of CORRECTION-06: ONE exact shape. Admitting `top` on argv[0] alone let
  // `docker top <c> -o args`, `-o pid,args`, `-o command` and a bare
  // `docker top <c>` (whose default format includes CMD) through the boundary
  // the architecture claims makes command lines structurally unavailable. The
  // column set is now part of the predicate, so an argv column cannot be
  // requested at all.
  ["docker", (a) => a[0] === "top" && isSafeProcessTop(a)],
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

/**
 * The ONLY process-listing column set this harness may request.
 *
 * There is no `args`, `cmd` or `command` column and there cannot be one: the
 * acquisition argv's last element is the operator-supplied media URL — and,
 * during the sentinel case, the sentinel itself.
 */
export const DOCKER_TOP_COLUMNS = "pid,ppid,pgid,comm";

/** Docker's own container-name grammar, so the one dynamic token is still bounded. */
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** `docker top <container> -o pid,ppid,pgid,comm` and nothing else. */
function isSafeProcessTop(argv) {
  return (
    argv.length === 4 &&
    CONTAINER_NAME_PATTERN.test(String(argv[1])) &&
    argv[2] === "-o" &&
    argv[3] === DOCKER_TOP_COLUMNS
  );
}

/**
 * The only container templates the allowlist admits.
 *
 * `docker inspect --format <one of these> <container>` and nothing else. The
 * environment is not among them, and cannot be.
 */
const ALLOWED_INSPECT_FORMATS = Object.freeze([
  "{{.Image}}",
  "{{.HostConfig.NetworkMode}}",
  "{{.State.Pid}}",
  // §9 of CORRECTION-07: the container's own object id — the RUNTIME EPOCH.
  //
  // Not a secret: a 64-hex content-addressed name for a container object, in
  // the same family as an image id, carrying no environment, no argv and no
  // configuration. It is added because image identity answers "which reviewed
  // image?" and cannot answer "which running instance produced this
  // evidence?", and the unit runs `docker run --rm` with an
  // `ExecStartPre=-docker rm -f`, so a Worker restart genuinely creates a new
  // container object rather than reusing one.
  "{{.Id}}",
]);

function isAllowedInspect(argv) {
  return (
    argv.length === 4 &&
    argv[1] === "--format" &&
    ALLOWED_INSPECT_FORMATS.includes(argv[2])
  );
}

/** `docker image inspect --format {{.Id}} <reference>` and nothing else. */
function isAllowedImageInspect(argv) {
  return argv.length === 5 && argv[2] === "--format" && argv[3] === "{{.Id}}";
}

/** The only in-container commands the allowlist admits. */
function isVersionProbe(argv) {
  const joined = argv.slice(2).join(" "); // drop `exec <container>`
  return (
    joined === "/usr/bin/python3 --version" ||
    joined === "node --version" ||
    joined === "/usr/bin/python3 /usr/local/lib/videofetch/yt-dlp --version" ||
    joined === EJS_PROBE_ARGV.join(" ") ||
    // §6 of CORRECTION-05: three FIXED environment probes, matched whole. The
    // variable name is inside the constant, so no argument the caller supplies
    // can redirect the read to a different variable.
    joined === ENV_NAMES_PROBE_ARGV.join(" ") ||
    joined === YTDLP_ENABLED_PROBE_ARGV.join(" ") ||
    joined === MAX_FILE_SIZE_PROBE_ARGV.join(" ") ||
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

// ── The environment probes (§4-§6 of CORRECTION-05) ────────────────────────
//
// The previous observers rendered `{{range .Config.Env}}{{println .}}{{end}}`,
// which emits the COMPLETE `NAME=value` environment — `WORKER_CONTROL_SECRET`
// included — and then discarded the values in JavaScript.
//
// That is the wrong order of operations for a harness whose subject holds
// secrets. The value crossed the process boundary into the harness before
// anything decided it was unwanted: it existed in a Node string, in the child
// process's stdout buffer, and in any core dump or stack trace taken in
// between. "Fetched, then sanitized" is not "never fetched".
//
// These three probes retrieve only what is needed. Each source string is a
// COMPILE-TIME CONSTANT admitted by the exact `docker exec` allowlist, so the
// caller cannot choose which variable is read — there is no general Python
// execution capability here, only three fixed questions.

/**
 * Names only. Environment variable names cannot contain `=` or a newline, so a
 * line-oriented reading is exact — and no `=` is ever printed, so no value can
 * ride along.
 */
export const ENV_NAMES_PROBE_ARGV = Object.freeze([
  "/usr/bin/python3",
  "-c",
  'import os;print("\n".join(sorted(os.environ)))',
]);

/**
 * The two non-secret deployment variables, each by NAME, each in its own probe.
 *
 * `<UNSET>` vs `SET:<value>` rather than a bare value, because a bare sentinel
 * is ambiguous: a variable literally set to `<UNSET>` would be indistinguishable
 * from an absent one, and for `YTDLP_ENABLED` that ambiguity resolves to
 * "disabled" — a silent misreading of the deployment's own feature state.
 */
export const YTDLP_ENABLED_PROBE_ARGV = Object.freeze([
  "/usr/bin/python3",
  "-c",
  'import os;v=os.environ.get("YTDLP_ENABLED");print("<UNSET>" if v is None else "SET:"+v)',
]);

export const MAX_FILE_SIZE_PROBE_ARGV = Object.freeze([
  "/usr/bin/python3",
  "-c",
  'import os;v=os.environ.get("MAX_FILE_SIZE");print("<UNSET>" if v is None else "SET:"+v)',
]);

/**
 * Decodes one `<UNSET>` / `SET:<value>` probe result.
 *
 * `print` appends exactly one newline, which is removed; nothing else is
 * trimmed here, so a value's own surrounding whitespace reaches the caller
 * intact and is subjected to the runtime's own grammar rather than this
 * function's guess. An embedded newline in the value survives too, because the
 * prefix is stripped from the WHOLE output rather than from a first line.
 */
export function decodeEnvProbe(stdout) {
  const raw = String(stdout ?? "");
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (body === "<UNSET>") return { measured: true, present: false, value: null };
  if (body.startsWith("SET:")) return { measured: true, present: true, value: body.slice(4) };
  return { measured: false, reason: "the environment probe did not return its fixed shape" };
}

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

  /**
   * `docker inspect --format` on the container, returning a trimmed scalar.
   *
   * §6/§7 of CORRECTION-07: a non-zero exit means the command FAILED, and its
   * stdout is not a measurement. This one helper backs `runningImageId`,
   * `imageShaTag`, `networkMode` and `containerPid` — four claims of the form
   * "this scalar was measured" — so consuming a failed command's buffer here
   * would have propagated a fabricated measurement to all of them at once.
   *
   * Throwing (rather than returning "") is what turns it into `measured:
   * false`, because every caller runs inside `observe`.
   */
  async function inspectContainer(format) {
    const result = await run("docker", ["inspect", "--format", format, container]);
    if (result.exitCode !== 0) {
      throw new Error(
        `docker inspect ${format} exited ${result.exitCode}; the value was not measured`,
      );
    }
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
    /**
     * STATUS-AS-DATA, deliberately preserved through the §7 audit.
     *
     * `is-active` exits non-zero precisely BECAUSE the unit is inactive, and
     * inactive is the property under test. Making a non-zero exit BLOCKED here
     * would convert the finding "the unit is not running" into the refusal "we
     * could not tell", which is the inverse of the harness's model. The same
     * reasoning preserves `egressVerifier` and the `verifierExit` field of
     * `egressPolicyState`.
     */
    async serviceState(unit) {
      return observe(`systemctl is-active ${unit}`, async () => {
        const result = await run("systemctl", ["is-active", unit]);
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
     * The Worker's bound environment VARIABLE NAMES (§16/§17; §5A of
     * CORRECTION-05).
     *
     * The probe prints names and nothing else — no `=`, no value, no value
     * length, no value hash. The previous implementation retrieved the complete
     * `NAME=value` environment and split the values off afterwards, which meant
     * every Worker secret was pulled into the harness process before anything
     * decided it was unwanted.
     */
    async environmentNames() {
      return observe("worker environment names", async () => {
        const result = await run("docker", ["exec", container, ...ENV_NAMES_PROBE_ARGV]);
        if (result.exitCode !== 0) throw new Error("the environment-name probe failed");
        const names = String(result.stdout ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((name) => name.length > 0);
        // A name can never contain `=`. If one does, the probe did not return
        // what this observer is defined to return, and the safest reading is a
        // measurement failure rather than a best-effort parse of unknown text.
        if (names.some((name) => name.includes("="))) {
          throw new Error("the environment-name probe returned a value-bearing line");
        }
        return names;
      });
    },

    /**
     * `YTDLP_ENABLED` as the deployment actually set it (§5B).
     *
     * ONE variable, by name, inside a fixed probe. worker.env is never opened,
     * and no other environment value is retrieved. An unset variable yields
     * `null`, which Stage A treats as disabled.
     */
    async ytdlpEnabledRaw() {
      return observe("YTDLP_ENABLED", async () => {
        const result = await run("docker", ["exec", container, ...YTDLP_ENABLED_PROBE_ARGV]);
        if (result.exitCode !== 0) throw new Error("the YTDLP_ENABLED probe failed");
        const decoded = decodeEnvProbe(result.stdout);
        if (decoded.measured !== true) throw new Error(decoded.reason);
        return decoded.present ? decoded.value.trim() : null;
      });
    },

    /**
     * The EFFECTIVE `maxFileSizeBytes` the deployed Worker enforces (§13 of
     * CORRECTION-04; §5C of CORRECTION-05).
     *
     * ONE variable, by name, inside a fixed probe — the byte-limit assertion is
     * a numeric comparison and cannot be made against a name alone, so this is
     * the narrowest observation that answers it.
     */
    async effectiveMaxFileSize() {
      return observe("MAX_FILE_SIZE", async () => {
        const result = await run("docker", ["exec", container, ...MAX_FILE_SIZE_PROBE_ARGV]);
        if (result.exitCode !== 0) throw new Error("the MAX_FILE_SIZE probe failed");
        const decoded = decodeEnvProbe(result.stdout);
        if (decoded.measured !== true) throw new Error(decoded.reason);
        const parsed = parseMaxFileSize(decoded.present ? decoded.value : null);
        if (parsed.measured !== true) throw new Error(parsed.reason);
        return { bytes: parsed.bytes, source: parsed.source };
      });
    },

    /** STATUS-AS-DATA (see `serviceState`). Reported, never repaired (§50). */
    async egressVerifier() {
      return observe("vf-egress-policy-verify", async () => {
        const result = await run("/usr/local/sbin/vf-egress-policy-verify", []);
        return { exitCode: result.exitCode };
      });
    },

    /**
     * §7 of CORRECTION-07: a version is a MEASUREMENT, so the probe must have
     * succeeded. `python3 --version` writes to stdout on modern CPython and to
     * stderr on older ones, which is why both streams are read — but a
     * non-zero exit means neither stream is an answer.
     */
    async pythonVersion() {
      return observe("python3 --version", async () => {
        const result = await run("docker", ["exec", container, "/usr/bin/python3", "--version"]);
        if (result.exitCode !== 0) {
          throw new Error(`the python3 version probe exited ${result.exitCode}`);
        }
        return String(result.stdout || result.stderr || "").trim().replace(/^Python\s+/i, "");
      });
    },

    async nodeVersion() {
      return observe("node --version", async () => {
        const result = await run("docker", ["exec", container, "node", "--version"]);
        if (result.exitCode !== 0) {
          throw new Error(`the node version probe exited ${result.exitCode}`);
        }
        return String(result.stdout ?? "").trim();
      });
    },

    /** §7 of CORRECTION-01 — the concrete bundled-EJS observer. */
    async bundledEjsVersion() {
      return observe("bundled yt_dlp_ejs version", async () => {
        const result = await run("docker", ["exec", container, ...EJS_PROBE_ARGV]);
        // §7 of CORRECTION-07. The probe's own failure path prints the fixed
        // token `UNAVAILABLE` and exits 0, so a NON-ZERO exit is something else
        // entirely — the exec never ran, or the interpreter died — and a
        // version-shaped buffer beside it was not measured from this image.
        if (result.exitCode !== 0) {
          throw new Error(`the EJS version probe exited ${result.exitCode}`);
        }
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
        // §7 of CORRECTION-07: `False` is the load-bearing answer here — it is
        // what proves the working directory was CLEANED UP — so a `False`
        // printed beside a non-zero exit is the single most favourable string
        // this probe could fabricate.
        if (result.exitCode !== 0) {
          throw new Error(`the workDir probe exited ${result.exitCode}`);
        }
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
     * The RUNTIME EPOCH: which container object is currently running (§9 of
     * CORRECTION-07).
     *
     * ── Why this is not the same question as the image ────────────────────
     *
     * `imageShaTag` answers "is the reviewed, authorized image running?" and
     * that binding is not replaced by anything here. What it cannot answer is
     * "did ONE running instance produce this evidence?", because a restart
     * legitimately brings the same image back as a different container. A case
     * whose evidence straddles an unnoticed recreation is two half-observations
     * of two runtimes reported as one observation of one.
     *
     * Named `containerInstanceId` rather than anything suggesting provenance:
     * the CODE's provenance is the image id and the source SHA, and this is
     * only a correlation token for the interval an observation covers.
     *
     * Non-secret — a content-addressed object name, carrying no environment, no
     * argv, no configuration.
     */
    async containerInstanceId() {
      return observe("docker inspect container id", async () => {
        const id = await inspectContainer("{{.Id}}");
        if (!/^[0-9a-f]{64}$/.test(id)) {
          throw new Error("the container reported no usable instance id");
        }
        return id;
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
        // §7 of CORRECTION-07. This PID is handed to `nsenter -t <pid> -n`; a
        // fabricated one would read the deny counters of whatever namespace
        // that PID happens to be in, which is a wrong measurement rather than a
        // missing one.
        if (result.exitCode !== 0) {
          throw new Error(`docker inspect exited ${result.exitCode}; the namespace holder PID was not measured`);
        }
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
 * The fixed token that stands in for a `comm` this harness will not copy
 * verbatim (§21 of CORRECTION-05).
 *
 * A survivor is never dropped for having an unusual name — it is kept with its
 * name replaced, so the row still counts as a survivor while nothing unexpected
 * from the host reaches the evidence.
 */
export const UNCLASSIFIED_COMM = "<unclassified>";

/** A plain executable basename, safe to carry into evidence verbatim. */
const SAFE_COMM_PATTERN = /^[\w.:+-]{1,64}$/;

/**
 * Parses `ps -eo pid=,ppid=,pgid=,comm=` into closed-schema rows, FAIL-CLOSED
 * on the part that matters (§19-§21 of CORRECTION-05).
 *
 * ── The format, and what it does and does not contain ──────────────────────
 *
 * The allowlist admits exactly one `ps` invocation, and it selects four columns
 * by name. There is no `args`, `cmd` or `command` column, so the trailing text
 * on every line is the `comm` field — the executable name — and never argv.
 * That boundary is what makes reading the remainder of the line safe.
 *
 * ── Why "split on whitespace, require 4 tokens" was wrong ──────────────────
 *
 * procps permits a `comm` containing spaces: it is derived from the executable
 * name, and an unrelated process on the host may legitimately have one. The
 * previous parser refused any line with a fifth token, so ONE unrelated process
 * with a spaced name made the entire host listing unmeasurable — and every
 * termination check BLOCKED — for a reason that had nothing to do with the
 * captured group. That is a fail-closed rule misapplied: it converts an
 * irrelevant oddity into an unanswerable question.
 *
 * ── What is still fail-closed, and why ─────────────────────────────────────
 *
 * The listing exists to answer one question: does the captured PGID still have
 * members? So the NUMERIC PREFIX is what must parse. A line whose pid/ppid/pgid
 * cannot be read might belong to the captured group, and dropping it would turn
 * a real survivor into an empty set — the exact PASS this must never produce.
 * Any such line makes the whole listing unmeasured, and the check BLOCKED.
 *
 * An unusual `comm` is different: the row is structurally understood, and its
 * group membership is known. It is kept, with an unrecognizable name replaced
 * by `UNCLASSIFIED_COMM` so nothing unexpected is copied into evidence. If such
 * a row IS in the captured group, `evaluateGroupTermination` cannot classify it
 * as a plausible acquisition member and reports the survivor set as ambiguous —
 * BLOCKED, never `[]`.
 *
 * @returns `{ ok: true, rows }` or `{ ok: false, reason }`. The reason names the
 *   line NUMBER and the defect, never the line's content — a line whose numeric
 *   prefix is unreadable is precisely the case where the rest might not be a
 *   `comm` at all.
 */
export function parseHostProcessList(stdout) {
  const rows = [];
  const lines = String(stdout ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // A blank line carries no process and hides nothing.
    if (line.trim().length === 0) continue;

    // Three numeric columns, then the remainder as `comm`. The remainder is
    // NOT re-split: it is one field by the format's own definition.
    const matched = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!matched) {
      return {
        ok: false,
        reason:
          `line ${index + 1} of the host process listing does not begin with the three numeric ` +
          "ids the requested format produces, so it cannot be assigned to a process group; " +
          "the listing cannot be interpreted",
      };
    }

    const [, pid, ppid, pgid, comm] = matched;
    const numbers = [Number(pid), Number(ppid), Number(pgid)];
    if (!numbers.every((value) => Number.isSafeInteger(value))) {
      return {
        ok: false,
        reason: `line ${index + 1} of the host process listing has an out-of-range id field`,
      };
    }

    rows.push({
      pid: numbers[0],
      ppid: numbers[1],
      pgid: numbers[2],
      // Kept verbatim only when it is a plain basename; otherwise the row
      // survives under a fixed token. Never dropped — see the docblock.
      comm: SAFE_COMM_PATTERN.test(comm) ? comm.toLowerCase() : UNCLASSIFIED_COMM,
    });
  }
  return { ok: true, rows };
}
