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

/**
 * The durable state the Worker owns on the VM. Read-only, and never copied.
 *
 * These three names are the DEPLOYMENT CONTRACT, not harness inventions. The
 * harness previously carried its own parallel guesses for all three and was
 * wrong about every one of them:
 *
 *   database   videofetch.db  ->  worker.sqlite   (WORKER_DATABASE_FILENAME in
 *                                  src/worker/runtime/state-directory.server.ts)
 *   table      jobs           ->  worker_jobs     (CREATE TABLE worker_jobs in
 *                                  src/worker/state/migrations.server.ts)
 *   access     `sqlite3` CLI  ->  node:sqlite     (the Worker's own driver)
 *
 * None of that could ever have measured Production: the file does not exist,
 * the table does not exist, and the executable is not installed on the VM. The
 * durable checks would have reported BLOCKED for a reason that had nothing to
 * do with the deployment under test.
 *
 * The harness cannot IMPORT the Worker's constants: it is a standalone `.mjs`
 * tool that runs on the VM host with no TypeScript loader, while the Worker's
 * constants live in `.ts` behind the repository's alias/type-stripping setup.
 * So the values are restated here exactly once, and a regression in
 * `scripts/ytdlp-acceptance.test.mjs` cross-checks each of them against the
 * Worker source that defines it. A restated constant with a cross-check is a
 * contract; a restated constant without one is the defect above.
 */
export const WORKER_STATE_DIRECTORY = "/var/lib/videofetch";
export const WORKER_DATABASE_FILENAME = "worker.sqlite";
export const WORKER_STATE_DB = `${WORKER_STATE_DIRECTORY}/${WORKER_DATABASE_FILENAME}`;

/** The durable table the Worker's own migration creates. */
export const WORKER_JOBS_TABLE = "worker_jobs";

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

/** Refuses a job id outside the Worker's own durable grammar. */
export function assertDurableJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error("refusing to query a malformed job id");
  }
  return jobId;
}

/**
 * The ONE statement this harness may ever run against durable state.
 *
 * A module-level constant with a BOUND parameter, not a string built per call.
 * The previous form interpolated the job id into the SQL after validating it,
 * which was safe only for as long as the validator and the interpolation stayed
 * in agreement — a coupling that has to be re-proven every time either moves.
 * A placeholder removes the question: the id is data to SQLite, and the
 * statement text is a constant no caller can influence.
 *
 * The projection is the safe column list, and `url` is not in it. That is a
 * PROJECTION, not a post-filter: the column holds the operator-supplied
 * acceptance URL and, during the sentinel case, the sentinel itself, so it must
 * never enter this process at all. Reading the row and deleting the field
 * afterwards would be the "fetched, then sanitized" pattern CORRECTION-05
 * removed from the environment probes for exactly the same reason.
 */
export const DURABLE_JOB_QUERY = `SELECT ${DURABLE_SAFE_COLUMNS.join(
  ", ",
)} FROM ${WORKER_JOBS_TABLE} WHERE job_id = ?`;

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
  // The durable read, as ONE fixed in-container question. Separate from the
  // version probes because it is a different contract: a different executable
  // (`/usr/local/bin/node`), a different argument shape, and one dynamic token
  // — the validated 32-hex job id. Folding it into `isVersionProbe` would have
  // widened a predicate whose whole value is that it is narrow.
  ["docker", (a) => a[0] === "exec" && isDurableProbe(a)],
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
  // `sqlite3` is DELIBERATELY ABSENT from this allowlist.
  //
  // It is not installed on the Phase-10D VM, so the retired entry could never
  // have produced a measurement there — and an allowlisted `sqlite3` shape is a
  // SQL-console-shaped hole kept open by a regex. The durable read is now the
  // fixed in-container probe above, so the CLI boundary is GONE rather than
  // dormant. `scripts/ytdlp-acceptance.test.mjs` asserts that no `sqlite3`
  // command is admissible here in any shape.
]);

/**
 * The ONLY process-listing column set this harness may request.
 *
 * There is no `args`, `cmd` or `command` column and there cannot be one: the
 * acquisition argv's last element is the operator-supplied media URL — and,
 * during the sentinel case, the sentinel itself.
 */
export const DOCKER_TOP_COLUMNS = "pid,ppid,pgid,comm";

/**
 * The container that OWNS the media network namespace.
 *
 * An application-owned literal, never derived from what Docker reported: the
 * whole point of the placement proof is to compare the Worker's declared target
 * against this container's independently resolved identity.
 */
export const MEDIA_NETNS_CONTAINER = "videofetch-media-netns";

/** Docker's canonical container object id: 64 lowercase hex, no `sha256:`. */
export const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A container-scoped network mode, as Docker ACTUALLY renders it.
 *
 * `--network container:<name>` is resolved at creation time and stored as the
 * target's canonical id, so `.HostConfig.NetworkMode` reads
 * `container:<64-hex>` and NEVER `container:<name>` on a running container.
 * Matching the name was the REMEDIATION-02 defect: it made a correctly placed
 * Worker fail.
 */
export const CONTAINER_NETWORK_MODE_PATTERN = /^container:([0-9a-f]{64})$/;

/** A Linux network-namespace identity as `readlink /proc/<pid>/ns/net` reports it. */
export const NET_NAMESPACE_PATTERN = /^net:\[\d+\]$/;

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
 *
 * ── The name is `version`, not `__version__` (REMEDIATION-02) ──────────────
 *
 * The first authenticated Stage-A run reported `runtime.bundled-ejs` as
 * NOT MEASURABLE, and the cause was this probe rather than the image. The
 * pinned EJS 0.8.0 package exposes exactly one public name:
 *
 *     from yt_dlp_ejs._version import version
 *     __all__ = ["version"]
 *
 * so `from yt_dlp_ejs import __version__` raises `ImportError`, the probe's own
 * `except` prints `UNAVAILABLE`, and the harness concluded the runtime could
 * not answer. Measured against the reviewed image, `__version__` is absent and
 * `version` is `0.8.0`.
 *
 * That is the failure mode this file must not repeat: a probe that asks a
 * package for an API it does not expose reports the INSTRUMENT's error as the
 * SUBJECT's. The regression for this probe therefore executes it against the
 * real reviewed image rather than a mocked `"0.8.0"` on stdout — a mock is
 * exactly what let the wrong import survive review.
 */
export const EJS_PROBE_ARGV = Object.freeze([
  "/usr/bin/python3",
  "-c",
  "import sys;sys.path.insert(0,'/usr/local/lib/videofetch/yt-dlp')\n" +
    "try:\n from yt_dlp_ejs import version as v\n print(v)\n" +
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
 *
 * ── The `\n` escaping is load-bearing (REMEDIATION-02) ─────────────────────
 *
 * The first authenticated Stage-A run reported both `worker-env` checks as NOT
 * MEASURABLE. The cause was this constant: a JavaScript `'\n'` is a real
 * newline, so the Python source that actually reached the interpreter was
 *
 *     import os;print("
 *     ".join(sorted(os.environ)))
 *
 * whose `"` literal is unterminated. `python3 -c` exited non-zero with a
 * `SyntaxError` and the observer correctly reported a failed measurement — of
 * an instrument that had never been executed against a real container.
 *
 * The probe is now asserted BY EXECUTION against a disposable container, so a
 * source string that is not valid Python cannot pass review again.
 */
export const ENV_NAMES_PROBE_ARGV = Object.freeze([
  "/usr/bin/python3",
  "-c",
  // The separator is written `\\n` so PYTHON receives the two characters
  // `\` `n` and parses them as its own newline escape. Writing `\n` here would
  // make JAVASCRIPT substitute a real newline before the string ever reaches
  // Python, splitting the `"` literal across two physical lines — which is a
  // `SyntaxError: unterminated string literal`, not a probe (REMEDIATION-02).
  'import os;print("\\n".join(sorted(os.environ)))',
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

// ── Durable state, read INSIDE the Worker container ────────────────────────
//
// The first remediation read the database from the host with `node:sqlite`.
// That removed the `sqlite3` dependency and replaced it with a worse one: the
// Phase-10D Lima host runs Node v18.19.1, which has no `node:sqlite` at all, so
// the observer still could not measure the deployment — and it now also needed
// filesystem privilege to traverse the Worker's `0700` state directory.
//
// Trading one unmet host prerequisite for another is not remediation. The
// runtime that can already do this ships WITH the deployment:
//
//   /usr/local/bin/node   in the reviewed Worker image   Node v22.23.2
//   node:sqlite           present, no flag required
//   /var/lib/videofetch   already mounted, already owned by the Worker's uid
//
// So the probe runs there, under the Worker's own runtime identity, and the
// host only has to spawn one exactly-allowlisted command and parse a small
// closed response. The host needs no SQLite, no database permission, and no
// Node newer than the one the VM already has.

/** The Worker image's own Node. Fixed: this is the reviewed runtime, not a lookup. */
export const WORKER_NODE_PATH = "/usr/local/bin/node";

/** Stdout ceiling for the probe. The closed response is a couple of hundred bytes. */
export const DURABLE_PROBE_MAX_STDOUT = 8 * 1024;

/**
 * The complete in-container durable probe, as a COMPILE-TIME CONSTANT.
 *
 * This is the same discipline CORRECTION-05 applied to the environment probes:
 * the allowlist matches this exact string, so `docker exec … node -e <script>`
 * is not a general execution capability — it is one fixed question. A different
 * script, a different database, a different table, an extra column or an extra
 * argument is refused before a process is spawned.
 *
 * What it may emit is equally closed (§7 of CORRECTION-01):
 *
 *   {"kind":"row","jobId":…,"status":…,"formatId":…,"extractor":…}
 *   {"kind":"absent","jobId":…}
 *   {"kind":"error","code":"database-open-failed"|"query-failed"|"probe-runtime-failed"}
 *
 * No URL, no SQL, no path, no raw SQLite message, no stack, no argv, no
 * environment. The script catches its own failures precisely so that none of
 * that text can cross the `docker exec` boundary in the first place — the same
 * "never fetched" rather than "fetched, then sanitized" rule used everywhere
 * else here.
 *
 * It exits 0 whenever it produced a closed response, INCLUDING its error kinds.
 * That keeps CORRECTION-07's rule intact rather than bending it: a non-zero
 * exit means the probe itself did not run, and its stdout is not evidence of
 * anything. The outcome lives in `kind`, which is inside the response the
 * process successfully produced.
 */
export const DURABLE_PROBE_SOURCE = [
  'const out=(o)=>process.stdout.write(JSON.stringify(o));',
  'const run=()=>{',
  'const j=process.argv[1];',
  'if(!/^[0-9a-f]{32}$/.test(String(j||"")))return{kind:"error",code:"probe-runtime-failed"};',
  'let D;',
  'try{D=require("node:sqlite").DatabaseSync;}catch{return{kind:"error",code:"probe-runtime-failed"};}',
  'let db;',
  'try{db=new D("/var/lib/videofetch/worker.sqlite",{readOnly:true});}',
  'catch{return{kind:"error",code:"database-open-failed"};}',
  'try{',
  'const r=db.prepare("SELECT job_id, status, format_id, extractor FROM worker_jobs WHERE job_id = ?").get(j);',
  'if(!r)return{kind:"absent",jobId:j};',
  'return{kind:"row",jobId:r.job_id,status:r.status,formatId:r.format_id??null,extractor:r.extractor??null};',
  '}catch{return{kind:"error",code:"query-failed"};}',
  'finally{try{db.close();}catch{}}',
  '};',
  'try{out(run());}catch{out({kind:"error",code:"probe-runtime-failed"});}',
].join("");

/** The closed set of failure classes the probe may name. */
export const DURABLE_PROBE_ERROR_CODES = Object.freeze({
  "database-open-failed": "the durable database could not be opened read-only",
  "query-failed": "the durable query failed",
  "probe-runtime-failed": "the durable probe could not run inside the Worker",
});

/** The one admissible durable-probe argv, for a validated container and job id. */
export function durableProbeArgv(container, jobId) {
  if (!CONTAINER_NAME_PATTERN.test(String(container))) {
    throw new Error("refusing to probe a malformed container name");
  }
  assertDurableJobId(jobId);
  return ["exec", container, WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE, jobId];
}

/** `docker exec <container> /usr/local/bin/node -e <fixed probe> <32-hex>` and nothing else. */
function isDurableProbe(argv) {
  return (
    argv.length === 6 &&
    CONTAINER_NAME_PATTERN.test(String(argv[1])) &&
    argv[2] === WORKER_NODE_PATH &&
    argv[3] === "-e" &&
    argv[4] === DURABLE_PROBE_SOURCE &&
    typeof argv[5] === "string" &&
    JOB_ID_PATTERN.test(argv[5])
  );
}

/**
 * A failure to READ, as opposed to a row that is provably not there.
 *
 * These are different findings and must never share a story: one indicts the
 * instrument, the other the deployment. Only this one is unmeasured.
 */
export class DurableReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "DurableReadError";
  }
}

/**
 * Interprets the probe's closed response.
 *
 * Nothing here is partially trusted. An unknown `kind`, an unexpected key, a
 * mismatched job id, oversized output or unparseable JSON is a measurement
 * failure — because a response the harness cannot fully account for is not a
 * response it can grade a security-relevant claim from.
 */
export function parseDurableProbeResponse(stdout, jobId) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) throw new DurableReadError("the durable probe produced no response");
  if (text.length > DURABLE_PROBE_MAX_STDOUT) {
    throw new DurableReadError("the durable probe response exceeded its size bound");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The text is NOT quoted back. A response the parser could not read is
    // exactly the one whose content cannot be assumed safe to echo.
    throw new DurableReadError("the durable probe response was not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DurableReadError("the durable probe response was not an object");
  }

  const keys = Object.keys(parsed).sort().join(",");
  if (parsed.kind === "row") {
    if (keys !== "extractor,formatId,jobId,kind,status") {
      throw new DurableReadError("the durable probe row did not match the projected columns");
    }
    if (parsed.jobId !== jobId) {
      throw new DurableReadError("the durable probe answered about a different job");
    }
    if (typeof parsed.status !== "string") {
      throw new DurableReadError("the durable probe row carried no status");
    }
    return {
      present: true,
      jobId,
      status: parsed.status,
      formatId: parsed.formatId ?? null,
      extractor: parsed.extractor ?? null,
    };
  }

  if (parsed.kind === "absent") {
    if (keys !== "jobId,kind") {
      throw new DurableReadError("the durable probe absence response carried unknown fields");
    }
    if (parsed.jobId !== jobId) {
      throw new DurableReadError("the durable probe answered about a different job");
    }
    // A MEASUREMENT (§12 of CORRECTION-01). The query ran and proved the row is
    // not there. Calling that "unmeasured" would report a deployment defect as
    // an inability to look, which is the inversion this harness exists to stop.
    return { present: false, jobId, status: null, formatId: null, extractor: null };
  }

  if (parsed.kind === "error") {
    const reason = DURABLE_PROBE_ERROR_CODES[parsed.code];
    if (!reason) throw new DurableReadError("the durable probe reported an unknown failure class");
    throw new DurableReadError(reason);
  }

  throw new DurableReadError("the durable probe response had an unknown kind");
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

  /**
   * `docker inspect --format <template> <named container>`.
   *
   * The name is checked against Docker's own grammar so the one dynamic token
   * stays bounded, and every caller passes an application-owned literal.
   */
  async function inspectNamed(name, format) {
    if (!CONTAINER_NAME_PATTERN.test(String(name))) {
      throw new Error("refusing to inspect a malformed container name");
    }
    const result = await run("docker", ["inspect", "--format", format, name]);
    if (result.exitCode !== 0) {
      throw new Error(`docker inspect ${format} exited ${result.exitCode}; the value was not measured`);
    }
    return String(result.stdout ?? "").trim();
  }

  /**
   * A container's main PID, or `null` when it is not running.
   *
   * A stopped container reports `0`, which is a MEASUREMENT ("not running")
   * rather than a failure, so it is normalized to null and returned for the
   * evaluator to fail closed on.
   */
  async function pidOf(name) {
    const pid = Number(await inspectNamed(name, "{{.State.Pid}}"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  /**
   * `readlink /proc/<pid>/ns/net`, or `null` when it cannot be read.
   *
   * Null is deliberate: the namespace identity is what the check compares, so
   * an unreadable link must never coincidentally equal another unreadable one.
   */
  async function netNamespaceOf(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const result = await run("readlink", [`/proc/${pid}/ns/net`]);
    if (result.exitCode !== 0) return null;
    const link = String(result.stdout ?? "").trim();
    return NET_NAMESPACE_PATTERN.test(link) ? link : null;
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

    /**
     * PROOF OF NETWORK PLACEMENT, not a string comparison (REMEDIATION-02).
     *
     * The Stage-A requirement is that the Worker SHARES the intended media
     * network namespace. The retired check asserted
     * `NetworkMode === "container:videofetch-media-netns"`, which Docker never
     * emits for a running container: `--network container:<name>` is resolved
     * at creation and stored as the target's canonical 64-hex id. The first
     * authenticated Stage-A run therefore FAILED a Worker that was correctly
     * placed — the harness was wrong, not the deployment.
     *
     * Two independent identities are measured and must agree:
     *
     *   A. the id the Worker's NetworkMode targets  ==  the id
     *      `videofetch-media-netns` actually resolves to;
     *   B. `readlink /proc/<worker-pid>/ns/net`     ==
     *      `readlink /proc/<media-netns-pid>/ns/net`.
     *
     * A alone would trust Docker's own bookkeeping; B alone would not prove the
     * shared namespace is the INTENDED one — a Worker sharing some other
     * container's namespace satisfies neither. Requiring both means a pass has
     * to survive Docker's configuration record AND the kernel's own view.
     *
     * Command failures throw, so an unobservable Docker daemon or a missing
     * container is reported as NOT MEASURED. Values that were read but are
     * wrong — a zero PID, an unreadable link, a mismatched id — are RETURNED,
     * so the evaluator fails them closed rather than hiding a real mismatch
     * behind "unavailable".
     */
    async networkPlacement() {
      return observe("worker network placement", async () => {
        const rawMode = await inspectContainer("{{.HostConfig.NetworkMode}}");
        const matched = CONTAINER_NETWORK_MODE_PATTERN.exec(rawMode);

        const workerPid = await pidOf(container);
        const mediaNetnsId = await inspectNamed(MEDIA_NETNS_CONTAINER, "{{.Id}}");
        const mediaPid = await pidOf(MEDIA_NETNS_CONTAINER);

        return {
          // `null` when the mode is not container-scoped at all (`bridge`,
          // `host`, `none`, a name-shaped value): measured, and not a target.
          targetContainerId: matched ? matched[1] : null,
          mediaNetnsContainerId: CONTAINER_ID_PATTERN.test(mediaNetnsId) ? mediaNetnsId : null,
          workerPid,
          mediaNetnsPid: mediaPid,
          workerNetNamespace: await netNamespaceOf(workerPid),
          mediaNetNamespace: await netNamespaceOf(mediaPid),
        };
      });
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
        const result = await run("docker", durableProbeArgv(container, jobId), {
          maxBuffer: DURABLE_PROBE_MAX_STDOUT,
        });
        // §7 of CORRECTION-07: a non-zero exit means the probe did not run, so
        // whatever is in the buffer beside it was not measured. stderr is never
        // read — the probe is written so nothing worth reading is ever there.
        if (result.exitCode !== 0) {
          throw new DurableReadError("the durable probe did not run inside the Worker container");
        }
        return parseDurableProbeResponse(result.stdout, jobId);
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
